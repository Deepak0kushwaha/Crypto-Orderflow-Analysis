
const path=require('path');
const http=require('http');
const express=require('express');
const WebSocket=require('ws');

const PORT=process.env.PORT||3000;
const MARKETS={
  BTCUSD:{stream:'btcusdt',tickSize:10,sweepNotional:500000,absorptionMinDelta:18,stallPct:0.0008},
  ETHUSD:{stream:'ethusdt',tickSize:0.5,sweepNotional:180000,absorptionMinDelta:140,stallPct:0.001},
  SOLUSD:{stream:'solusdt',tickSize:0.05,sweepNotional:80000,absorptionMinDelta:1200,stallPct:0.0015},
  XRPUSD:{stream:'xrpusdt',tickSize:0.0005,sweepNotional:45000,absorptionMinDelta:30000,stallPct:0.0018},
};
const TIMEFRAMES=[{key:'1m',ms:60000},{key:'5m',ms:300000},{key:'15m',ms:900000},{key:'1h',ms:3600000}];
const TIMEFRAME_LOOKUP=Object.fromEntries(TIMEFRAMES.map((t)=>[t.key,t]));
const DEFAULT_SYMBOL='BTCUSD';
const DEFAULT_TIMEFRAME='1m';
const STREAM_TO_SYMBOL=Object.fromEntries(Object.entries(MARKETS).map(([s,c])=>[c.stream,s]));
const BINANCE_SOURCES=[
  {name:'global',restBase:'https://api.binance.com',wsBase:'wss://stream.binance.com'},
  {name:'us',restBase:'https://api.binance.us',wsBase:'wss://stream.binance.us:9443'},
];
const BINANCE_SOURCE_PREF=(process.env.BINANCE_SOURCE||'auto').toLowerCase();
let activeBinanceSourceIndex=BINANCE_SOURCE_PREF==='us'?1:0;

const MAX_ALERTS=180;
const MAX_MINUTE_SERIES=120;
const MAX_BARS_PER_FRAME=380;
const MAX_BARS_DETAIL=220;
const BUBBLES_PER_BAR=6;
const MAX_BUBBLES_DETAIL=1200;
const MAX_SIGNALS_DETAIL=140;
const ORDER_BOOK_LEVELS=20;
const ORDER_BOOK_DETAIL_LEVELS=20;
const VOLUME_PROFILE_TARGET_BINS=42;
const VALUE_AREA_TARGET_PCT=0.7;
const SNAPSHOT_INTERVAL_MS=300;
const REST_FALLBACK_INTERVAL_MS=1200;
const REST_STALE_THRESHOLD_MS=2400;
const REST_RECENT_TRADES_LIMIT=30;

function getActiveBinanceSource(){
  return BINANCE_SOURCES[activeBinanceSourceIndex]||BINANCE_SOURCES[0];
}
function rotateBinanceSource(reason){
  if(BINANCE_SOURCES.length<2){return;}
  const prev=getActiveBinanceSource();
  activeBinanceSourceIndex=(activeBinanceSourceIndex+1)%BINANCE_SOURCES.length;
  const next=getActiveBinanceSource();
  console.log(`[binance] switching source ${prev.name} -> ${next.name}${reason?` (${reason})`:''}`);
}

function frameState(ms){return{ms,bars:new Map(),barKeys:[]};}
function symbolState(symbol,cfg){
  const frames={};
  TIMEFRAMES.forEach((tf)=>{frames[tf.key]=frameState(tf.ms);});
  return{
    symbol,cfg,lastPrice:null,cvd:0,spreadPct:0,lastTopBid:null,lastTopAsk:null,topBidQty5:0,topAskQty5:0,
    currentMinute:null,currentMinuteVolume:0,minuteSeries:[],tradeWindow:[],priceWindow:[],alerts:[],frames,
    lastAlertAt:{divergence:0,absorption:0,sweep:0},deltaEma:0,pendingDrops:{ask:null,bid:null},replenishments:[],sweepCandidates:[],
    orderBook:{ts:0,bids:[],asks:[],bidTotal:0,askTotal:0,imbalance:0,speed:0},lastDepthUpdateTs:0,depthRateEma:0,
    lastTradeUpdateTs:0,lastAnyMarketDataTs:0,lastRestTradeIds:Object.fromEntries(BINANCE_SOURCES.map((src)=>[src.name,0])),
  };
}
const state=Object.fromEntries(Object.entries(MARKETS).map(([s,c])=>[s,symbolState(s,c)]));

const mean=(arr)=>!arr||arr.length===0?0:arr.reduce((a,b)=>a+b,0)/arr.length;
const pruneByAge=(arr,now,age)=>{while(arr.length&&now-arr[0].ts>age){arr.shift();}};
const pruneByLength=(arr,n)=>{if(arr.length>n){arr.splice(0,arr.length-n);}};
const fmt=(v,d=2)=>Number.isFinite(v)?v.toFixed(d):'0';
function roundToTick(price,tick){const p=String(tick).includes('.')?String(tick).split('.')[1].length:0;return Number((Math.round(price/tick)*tick).toFixed(p));}
function roundToStep(v,step){const p=String(step).includes('.')?String(step).split('.')[1].length:0;return Number((Math.round(v/step)*step).toFixed(Math.min(p+2,8)));}
const addAlert=(s,a)=>{s.alerts.push(a);pruneByLength(s.alerts,MAX_ALERTS);};

function updateMinuteSeries(s,ts,qty){
  const m=Math.floor(ts/60000)*60000;
  if(s.currentMinute===null){s.currentMinute=m;}else if(m!==s.currentMinute){finalizeMinute(s,s.currentMinute);s.currentMinute=m;s.currentMinuteVolume=0;}
  s.currentMinuteVolume+=qty;
}
function finalizeMinute(s,minuteTs){
  if(s.lastPrice===null){return;}
  const prev=s.minuteSeries[s.minuteSeries.length-1];
  const minuteDelta=prev?s.cvd-prev.cvd:0;
  s.minuteSeries.push({ts:minuteTs,price:s.lastPrice,cvd:s.cvd,volume:s.currentMinuteVolume,minuteDelta});
  pruneByLength(s.minuteSeries,MAX_MINUTE_SERIES);
  detectCvdDivergence(s);
}
function ensureFrameBar(s,timeframeKey,barTs,price){
  const f=s.frames[timeframeKey];
  let b=f.bars.get(barTs);
  if(!b){
    b={ts:barTs,open:price,high:price,low:price,close:price,buyVol:0,sellVol:0,totalVol:0,delta:0,cvdClose:s.cvd,levels:new Map()};
    f.bars.set(barTs,b);f.barKeys.push(barTs);
    if(f.barKeys.length>MAX_BARS_PER_FRAME){const oldest=f.barKeys.shift();f.bars.delete(oldest);}
  }
  return b;
}
function updateBarsAndFootprint(s,ts,price,qty,isBuyerMaker){
  const buy=isBuyerMaker?0:qty;
  const sell=isBuyerMaker?qty:0;
  for(const tf of TIMEFRAMES){
    const barTs=Math.floor(ts/tf.ms)*tf.ms;
    const b=ensureFrameBar(s,tf.key,barTs,price);
    b.high=Math.max(b.high,price);b.low=Math.min(b.low,price);b.close=price;
    b.buyVol+=buy;b.sellVol+=sell;b.totalVol+=qty;b.delta=b.buyVol-b.sellVol;b.cvdClose=s.cvd;
    const level=roundToTick(price,s.cfg.tickSize);const k=String(level);
    if(!b.levels.has(k)){b.levels.set(k,{buy:0,sell:0,delta:0,total:0});}
    const cell=b.levels.get(k);cell.buy+=buy;cell.sell+=sell;cell.delta+=buy-sell;cell.total+=qty;
  }
}
function detectCvdDivergence(s){
  const series=s.minuteSeries;const lookback=5;const now=Date.now();
  if(series.length<lookback+1||now-s.lastAlertAt.divergence<75000){return;}
  const cur=series[series.length-1];const prev=series[series.length-1-lookback];
  if(!prev||prev.price===0){return;}
  const priceMove=(cur.price-prev.price)/prev.price;
  const cvdMove=cur.cvd-prev.cvd;
  const avgAbsDelta=mean(series.slice(-12).map((p)=>Math.abs(p.minuteDelta)));
  const cvdTh=Math.max(avgAbsDelta*1.2,s.cfg.absorptionMinDelta*2);
  const priceTh=0.0015;
  if(priceMove>priceTh&&cvdMove<-cvdTh){
    s.lastAlertAt.divergence=now;
    addAlert(s,{id:`${s.symbol}-div-bear-${now}`,ts:now,type:'CVD Divergence',severity:'high',bias:'bearish',price:s.lastPrice,
      message:`${s.symbol} bearish divergence: price +${fmt(priceMove*100,2)}% while CVD ${fmt(cvdMove,0)}.`});
  }
  if(priceMove<-priceTh&&cvdMove>cvdTh){
    s.lastAlertAt.divergence=now;
    addAlert(s,{id:`${s.symbol}-div-bull-${now}`,ts:now,type:'CVD Divergence',severity:'high',bias:'bullish',price:s.lastPrice,
      message:`${s.symbol} bullish divergence: price ${fmt(priceMove*100,2)}% while CVD +${fmt(cvdMove,0)}.`});
  }
}

function detectAbsorption(s,now){
  if(now-s.lastAlertAt.absorption<45000){return;}
  pruneByAge(s.tradeWindow,now,15000);pruneByAge(s.replenishments,now,7000);
  if(s.tradeWindow.length<8){return;}
  const delta=s.tradeWindow.reduce((sum,t)=>sum+t.deltaQty,0);
  const fp=s.tradeWindow[0].price;const lp=s.tradeWindow[s.tradeWindow.length-1].price;
  const movePct=fp>0?Math.abs((lp-fp)/fp):1;
  const largeDelta=Math.max(s.cfg.absorptionMinDelta,s.deltaEma*35);
  if(movePct>=s.cfg.stallPct||Math.abs(delta)<largeDelta){return;}
  const repl=s.replenishments.filter((r)=>now-r.ts<6000).sort((a,b)=>b.ts-a.ts)[0];
  if(!repl){return;}
  const buyAbs=delta>0&&repl.side==='ask';
  const sellAbs=delta<0&&repl.side==='bid';
  if(!buyAbs&&!sellAbs){return;}
  s.lastAlertAt.absorption=now;
  addAlert(s,{id:`${s.symbol}-abs-${now}`,ts:now,type:'Absorption',severity:'medium',bias:buyAbs?'bearish':'bullish',price:s.lastPrice,
    message:buyAbs
      ?`${s.symbol} ask absorption: strong buy delta (${fmt(delta,0)}) stalled while offers replenished.`
      :`${s.symbol} bid absorption: strong sell delta (${fmt(delta,0)}) stalled while bids replenished.`});
}

function detectSweep(s,now){
  if(now-s.lastAlertAt.sweep<30000){return;}
  pruneByAge(s.sweepCandidates,now,6000);pruneByAge(s.priceWindow,now,60000);
  if(s.priceWindow.length<8||s.lastPrice===null){return;}
  const breakoutPct=0.0006;
  for(const c of s.sweepCandidates){
    if(now-c.ts>5000){continue;}
    const prior=s.priceWindow.filter((p)=>p.ts<c.ts).map((p)=>p.price);
    if(prior.length<5){continue;}
    const priorLow=Math.min(...prior);const priorHigh=Math.max(...prior);
    if(c.direction==='up'&&s.lastPrice>priorHigh*(1+breakoutPct)){
      s.lastAlertAt.sweep=now;
      addAlert(s,{id:`${s.symbol}-sweep-up-${now}`,ts:now,type:'Liquidity Sweep',severity:'high',bias:'bullish',price:s.lastPrice,
        message:`${s.symbol} upside stop-run: ask liquidity swept (${fmt(c.notional,0)} USDT) and price broke recent highs.`});
      s.sweepCandidates=[];return;
    }
    if(c.direction==='down'&&s.lastPrice<priorLow*(1-breakoutPct)){
      s.lastAlertAt.sweep=now;
      addAlert(s,{id:`${s.symbol}-sweep-down-${now}`,ts:now,type:'Liquidity Sweep',severity:'high',bias:'bearish',price:s.lastPrice,
        message:`${s.symbol} downside stop-run: bid liquidity swept (${fmt(c.notional,0)} USDT) and price broke recent lows.`});
      s.sweepCandidates=[];return;
    }
  }
}

function handleTrade(data,s){
  const ts=Number(data.T||data.E||Date.now());
  const price=Number(data.p);const qty=Number(data.q);const isBuyerMaker=Boolean(data.m);
  if(!Number.isFinite(price)||!Number.isFinite(qty)||qty<=0){return;}
  s.lastTradeUpdateTs=ts;
  s.lastAnyMarketDataTs=ts;
  s.lastPrice=price;
  const deltaQty=isBuyerMaker?-qty:qty;
  s.cvd+=deltaQty;
  s.deltaEma=s.deltaEma*0.98+Math.abs(deltaQty)*0.02;
  s.tradeWindow.push({ts,price,deltaQty,qty});s.priceWindow.push({ts,price});
  pruneByAge(s.tradeWindow,ts,20000);pruneByAge(s.priceWindow,ts,70000);
  updateMinuteSeries(s,ts,qty);
  updateBarsAndFootprint(s,ts,price,qty,isBuyerMaker);
  detectAbsorption(s,ts);detectSweep(s,ts);
}

function handleDepth(data,s){
  const now=Number(data.E||Date.now());
  const rawBids=Array.isArray(data.b)?data.b:(Array.isArray(data.bids)?data.bids:[]);
  const rawAsks=Array.isArray(data.a)?data.a:(Array.isArray(data.asks)?data.asks:[]);
  if(!rawBids.length||!rawAsks.length){return;}
  const bids=rawBids.map(([p,q])=>({price:Number(p),qty:Number(q)}))
    .filter((x)=>Number.isFinite(x.price)&&Number.isFinite(x.qty)&&x.qty>0)
    .sort((a,b)=>b.price-a.price);
  const asks=rawAsks.map(([p,q])=>({price:Number(p),qty:Number(q)}))
    .filter((x)=>Number.isFinite(x.price)&&Number.isFinite(x.qty)&&x.qty>0)
    .sort((a,b)=>a.price-b.price);
  if(!bids.length||!asks.length){return;}
  s.lastAnyMarketDataTs=now;
  const topBid=bids[0].price;const topAsk=asks[0].price;
  s.lastTopBid=topBid;s.lastTopAsk=topAsk;s.spreadPct=topBid>0?(topAsk-topBid)/topBid:0;
  if(s.lastPrice===null&&Number.isFinite(topBid)&&Number.isFinite(topAsk)){s.lastPrice=(topBid+topAsk)/2;}
  const topBidQty5=bids.slice(0,5).reduce((sum,l)=>sum+l.qty,0);
  const topAskQty5=asks.slice(0,5).reduce((sum,l)=>sum+l.qty,0);

  if(s.lastDepthUpdateTs>0&&now>s.lastDepthUpdateTs){
    const instRate=1000/(now-s.lastDepthUpdateTs);
    s.depthRateEma=s.depthRateEma>0?s.depthRateEma*0.82+instRate*0.18:instRate;
  }
  s.lastDepthUpdateTs=now;
  const bookBids=bids.slice(0,ORDER_BOOK_LEVELS);
  const bookAsks=asks.slice(0,ORDER_BOOK_LEVELS);
  const bidTotal=bookBids.reduce((sum,l)=>sum+l.qty,0);
  const askTotal=bookAsks.reduce((sum,l)=>sum+l.qty,0);
  const denom=bidTotal+askTotal;
  s.orderBook={
    ts:now,
    bids:bookBids,
    asks:bookAsks,
    bidTotal,
    askTotal,
    imbalance:denom>0?(bidTotal-askTotal)/denom:0,
    speed:s.depthRateEma,
  };

  if(s.topAskQty5>0){
    const askDrop=(s.topAskQty5-topAskQty5)/s.topAskQty5;
    if(askDrop>0.32){
      const consumed=s.topAskQty5-topAskQty5;const px=s.lastPrice||topAsk;const notional=consumed*px;
      if(notional>s.cfg.sweepNotional){s.sweepCandidates.push({ts:now,direction:'up',notional});}
      s.pendingDrops.ask={ts:now,beforeQty:s.topAskQty5,afterQty:topAskQty5};
    }
  }
  if(s.topBidQty5>0){
    const bidDrop=(s.topBidQty5-topBidQty5)/s.topBidQty5;
    if(bidDrop>0.32){
      const consumed=s.topBidQty5-topBidQty5;const px=s.lastPrice||topBid;const notional=consumed*px;
      if(notional>s.cfg.sweepNotional){s.sweepCandidates.push({ts:now,direction:'down',notional});}
      s.pendingDrops.bid={ts:now,beforeQty:s.topBidQty5,afterQty:topBidQty5};
    }
  }

  if(s.pendingDrops.ask){
    const p=s.pendingDrops.ask;const recovered=topAskQty5>=p.beforeQty*0.9;
    if(recovered&&now-p.ts<6000){s.replenishments.push({ts:now,side:'ask',recoveredQty:topAskQty5-p.afterQty});s.pendingDrops.ask=null;}
    else if(now-p.ts>8000){s.pendingDrops.ask=null;}
  }
  if(s.pendingDrops.bid){
    const p=s.pendingDrops.bid;const recovered=topBidQty5>=p.beforeQty*0.9;
    if(recovered&&now-p.ts<6000){s.replenishments.push({ts:now,side:'bid',recoveredQty:topBidQty5-p.afterQty});s.pendingDrops.bid=null;}
    else if(now-p.ts>8000){s.pendingDrops.bid=null;}
  }

  s.topBidQty5=topBidQty5;s.topAskQty5=topAskQty5;
  pruneByAge(s.replenishments,now,12000);pruneByAge(s.sweepCandidates,now,8000);
}

function decorateOrderBookSide(levels){
  let cumulative=0;
  return levels.map((l)=>{
    cumulative+=l.qty;
    return{
      price:l.price,
      qty:l.qty,
      cumulative,
      notional:l.qty*l.price,
    };
  });
}

function buildOrderBookDetail(s){
  const raw=s.orderBook||{};
  const bids=decorateOrderBookSide(Array.isArray(raw.bids)?raw.bids.slice(0,ORDER_BOOK_DETAIL_LEVELS):[]);
  const asks=decorateOrderBookSide(Array.isArray(raw.asks)?raw.asks.slice(0,ORDER_BOOK_DETAIL_LEVELS):[]);

  const bestBid=bids[0]?.price??s.lastTopBid??null;
  const bestAsk=asks[0]?.price??s.lastTopAsk??null;
  const spread=Number.isFinite(bestBid)&&Number.isFinite(bestAsk)?bestAsk-bestBid:null;
  const spreadPct=Number.isFinite(spread)&&bestBid>0?spread/bestBid:0;
  const maxQty=Math.max(1,...bids.map((r)=>r.qty),...asks.map((r)=>r.qty));
  const bidTotal=bids.length?bids[bids.length-1].cumulative:(raw.bidTotal||0);
  const askTotal=asks.length?asks[asks.length-1].cumulative:(raw.askTotal||0);
  const imbalance=bidTotal+askTotal>0?(bidTotal-askTotal)/(bidTotal+askTotal):0;

  return{
    ts:raw.ts||0,
    bestBid,bestAsk,spread,spreadPct,
    midPrice:Number.isFinite(bestBid)&&Number.isFinite(bestAsk)?(bestBid+bestAsk)/2:null,
    bidTotal,askTotal,imbalance,
    speed:Number.isFinite(raw.speed)?raw.speed:0,
    maxQty,
    bids,asks,
  };
}
function buildCandlesFromFrame(s,timeframeKey,maxBars=MAX_BARS_DETAIL){
  const f=s.frames[timeframeKey]||s.frames[DEFAULT_TIMEFRAME];
  const keys=f.barKeys.slice().sort((a,b)=>a-b).slice(-maxBars);
  const candles=[];
  for(const ts of keys){
    const b=f.bars.get(ts);
    if(!b){continue;}
    candles.push({
      ts,open:b.open,high:b.high,low:b.low,close:b.close,
      buyVol:b.buyVol,sellVol:b.sellVol,totalVol:b.totalVol,delta:b.delta,levels:b.levels,cvdClose:b.cvdClose,
    });
  }
  return candles;
}

function selectDistinctZones(candidates,maxCount,minDistance){
  const out=[];
  for(const z of candidates){
    const close=out.some((x)=>Math.abs(x.center-z.center)<minDistance);
    if(close){continue;}
    out.push(z);
    if(out.length>=maxCount){break;}
  }
  return out;
}

function buildZoneModel(candles,cfg,referencePrice){
  if(!Number.isFinite(referencePrice)||candles.length<24){return{support:[],resistance:[],binSize:0};}
  const sample=candles.slice(-140);
  const avgRange=mean(sample.map((c)=>Math.max(c.high-c.low,cfg.tickSize)))||cfg.tickSize*6;
  const binSize=Math.max(cfg.tickSize*3,avgRange*0.35,referencePrice*0.0007);
  const bins=new Map();

  for(const c of sample){
    const center=roundToStep((c.high+c.low+c.close)/3,binSize);
    const k=center.toFixed(8);
    if(!bins.has(k)){bins.set(k,{center,vol:0,touches:0,supportRejections:0,resistanceRejections:0});}
    const e=bins.get(k);
    e.vol+=c.totalVol;
    if(c.low<=center&&c.high>=center){e.touches+=1;}
    if(c.low<center&&c.close>center){e.supportRejections+=1;}
    if(c.high>center&&c.close<center){e.resistanceRejections+=1;}
  }

  const rows=[...bins.values()];
  const maxVol=Math.max(...rows.map((r)=>r.vol),1);
  const rawSupport=[];const rawResistance=[];

  for(const r of rows){
    const type=r.center<=referencePrice?'support':'resistance';
    const dist=Math.abs(referencePrice-r.center);
    const distScore=1-Math.min(1,dist/Math.max(avgRange*18,cfg.tickSize*40));
    const rej=type==='support'?r.supportRejections:r.resistanceRejections;
    const score=(r.vol/maxVol)*58+r.touches*2.4+rej*8.5+distScore*10;
    const half=Math.max(binSize*0.46,cfg.tickSize*2);
    const zone={
      id:`${type}-${r.center}`,
      type,
      center:r.center,
      priceLow:r.center-half,
      priceHigh:r.center+half,
      score:Math.round(score),
      touches:r.touches,
      rejections:rej,
      volume:r.vol,
    };
    if(type==='support'){rawSupport.push(zone);}else{rawResistance.push(zone);}
  }

  rawSupport.sort((a,b)=>b.score-a.score);
  rawResistance.sort((a,b)=>b.score-a.score);
  const minDistance=Math.max(binSize*1.08,cfg.tickSize*4);

  const support=selectDistinctZones(rawSupport,4,minDistance).sort((a,b)=>b.center-a.center);
  const resistance=selectDistinctZones(rawResistance,4,minDistance).sort((a,b)=>a.center-b.center);
  return{support,resistance,binSize};
}

function buildVolumeProfile(s,candles,orderBook){
  if(!candles.length){
    return{
      binSize:s.cfg.tickSize,
      poc:null,
      valueArea:{high:null,low:null,coveragePct:0},
      stats:{totalVolume:0,buyVolume:0,sellVolume:0,delta:0},
      rows:[],
    };
  }

  const highs=candles.map((c)=>c.high).filter((v)=>Number.isFinite(v));
  const lows=candles.map((c)=>c.low).filter((v)=>Number.isFinite(v));
  const range=Math.max(s.cfg.tickSize,Math.max(...highs)-Math.min(...lows));
  const rawBin=range/VOLUME_PROFILE_TARGET_BINS;
  const binSize=Math.max(s.cfg.tickSize,roundToStep(rawBin,s.cfg.tickSize));
  const bins=new Map();

  for(const c of candles){
    let levels=[...c.levels.entries()].map(([k,v])=>({
      price:Number(k),
      buy:Number(v.buy)||0,
      sell:Number(v.sell)||0,
      total:Number(v.total)||0,
      delta:Number(v.delta),
    }));

    if(!levels.length){
      levels=[{
        price:c.close,
        buy:c.buyVol,
        sell:c.sellVol,
        total:c.totalVol,
        delta:c.delta,
      }];
    }

    for(const l of levels){
      if(!Number.isFinite(l.price)){continue;}
      const buy=Math.max(0,Number.isFinite(l.buy)?l.buy:0);
      const sell=Math.max(0,Number.isFinite(l.sell)?l.sell:0);
      const total=Math.max(0,Number.isFinite(l.total)?l.total:buy+sell);
      const delta=Number.isFinite(l.delta)?l.delta:buy-sell;
      if(total<=0){continue;}

      const price=roundToStep(l.price,binSize);
      const key=price.toFixed(8);
      if(!bins.has(key)){bins.set(key,{price,buy:0,sell:0,total:0,delta:0});}
      const row=bins.get(key);
      row.buy+=buy;
      row.sell+=sell;
      row.total+=total;
      row.delta+=delta;
    }
  }

  const rowsAsc=[...bins.values()].filter((r)=>r.total>0).sort((a,b)=>a.price-b.price);
  if(!rowsAsc.length){
    return{
      binSize,
      poc:null,
      valueArea:{high:null,low:null,coveragePct:0},
      stats:{totalVolume:0,buyVolume:0,sellVolume:0,delta:0},
      rows:[],
    };
  }

  const totalVolume=rowsAsc.reduce((sum,r)=>sum+r.total,0);
  const buyVolume=rowsAsc.reduce((sum,r)=>sum+r.buy,0);
  const sellVolume=rowsAsc.reduce((sum,r)=>sum+r.sell,0);
  const delta=buyVolume-sellVolume;

  let pocIndex=0;
  for(let i=1;i<rowsAsc.length;i+=1){
    if(rowsAsc[i].total>rowsAsc[pocIndex].total){pocIndex=i;}
  }

  const target=Math.max(0,totalVolume*VALUE_AREA_TARGET_PCT);
  let left=pocIndex;
  let right=pocIndex;
  let valueAreaVol=rowsAsc[pocIndex].total;
  while(valueAreaVol<target&&(left>0||right<rowsAsc.length-1)){
    const leftVol=left>0?rowsAsc[left-1].total:-1;
    const rightVol=right<rowsAsc.length-1?rowsAsc[right+1].total:-1;
    if(rightVol>=leftVol){
      right+=1;
      valueAreaVol+=rowsAsc[right].total;
    }else{
      left-=1;
      valueAreaVol+=rowsAsc[left].total;
    }
  }

  const poc=rowsAsc[pocIndex];
  const valueLow=rowsAsc[left].price;
  const valueHigh=rowsAsc[right].price;
  const maxTotal=Math.max(...rowsAsc.map((r)=>r.total),1);
  const bookByBin=new Map();
  if(orderBook){
    const addBookLevel=(price,qty,side)=>{
      if(!Number.isFinite(price)||!Number.isFinite(qty)||qty<=0){return;}
      const p=roundToStep(price,binSize);
      const k=p.toFixed(8);
      if(!bookByBin.has(k)){bookByBin.set(k,{bid:0,ask:0,total:0});}
      const row=bookByBin.get(k);
      if(side==='bid'){row.bid+=qty;}else{row.ask+=qty;}
      row.total=row.bid+row.ask;
    };
    (orderBook.bids||[]).forEach((l)=>addBookLevel(l.price,l.qty,'bid'));
    (orderBook.asks||[]).forEach((l)=>addBookLevel(l.price,l.qty,'ask'));
  }
  const maxBookTotal=Math.max(1,...[...bookByBin.values()].map((x)=>x.total));

  const rows=rowsAsc
    .slice()
    .sort((a,b)=>b.price-a.price)
    .map((r)=>{
      const b=bookByBin.get(r.price.toFixed(8))||{bid:0,ask:0,total:0};
      return{
        price:r.price,
        buy:r.buy,
        sell:r.sell,
        total:r.total,
        delta:r.delta,
        share:r.total/maxTotal,
        inValueArea:r.price>=valueLow&&r.price<=valueHigh,
        isPoc:r.price===poc.price,
        bookBid:b.bid,
        bookAsk:b.ask,
        bookTotal:b.total,
        bookShare:b.total/maxBookTotal,
      };
    });

  return{
    binSize,
    poc:{price:poc.price,buy:poc.buy,sell:poc.sell,total:poc.total,delta:poc.delta},
    valueArea:{high:valueHigh,low:valueLow,coveragePct:totalVolume>0?valueAreaVol/totalVolume:0},
    stats:{totalVolume,buyVolume,sellVolume,delta},
    rows,
  };
}

function nearestCandlePrice(candles,ts,fallbackPrice){
  if(!candles.length){return fallbackPrice;}
  let best=candles[0];let bestDiff=Math.abs(best.ts-ts);
  for(let i=1;i<candles.length;i+=1){
    const d=Math.abs(candles[i].ts-ts);
    if(d<bestDiff){best=candles[i];bestDiff=d;}
  }
  return best.close;
}
function computeConfluenceSignals(s,timeframeKey,candles,cvd,zones){
  const signals=[];
  if(candles.length<24||cvd.length<24){return signals;}
  const supportZones=zones.support;const resistanceZones=zones.resistance;
  const lastSignalBar={buy:-999,sell:-999};

  for(let i=18;i<candles.length;i+=1){
    const c=candles[i];
    const prev=candles.slice(i-18,i);
    const prevLow=Math.min(...prev.map((b)=>b.low));
    const prevHigh=Math.max(...prev.map((b)=>b.high));
    const avgRange=mean(prev.map((b)=>Math.max(b.high-b.low,s.cfg.tickSize)));
    const avgVol=mean(prev.map((b)=>b.totalVol));
    const avgAbsDelta=mean(prev.map((b)=>Math.abs(b.delta)));

    const cvdSlice=cvd.slice(i-18,i);
    const cvdNow=cvd[i].value;
    const prevCvdLow=Math.min(...cvdSlice.map((x)=>x.value));
    const prevCvdHigh=Math.max(...cvdSlice.map((x)=>x.value));

    const range=Math.max(c.high-c.low,s.cfg.tickSize);
    const body=Math.abs(c.close-c.open);
    const lowerWick=Math.max(0,Math.min(c.open,c.close)-c.low);
    const upperWick=Math.max(0,c.high-Math.max(c.open,c.close));
    const closeNearHigh=(c.close-c.low)/range>0.63;
    const closeNearLow=(c.high-c.close)/range>0.63;

    const nearThreshold=Math.max(avgRange*0.62,s.cfg.tickSize*6);
    const nearSupport=supportZones.some((z)=>Math.abs(c.close-z.center)<=nearThreshold||(c.low<=z.priceHigh&&c.high>=z.priceLow));
    const nearResistance=resistanceZones.some((z)=>Math.abs(c.close-z.center)<=nearThreshold||(c.low<=z.priceHigh&&c.high>=z.priceLow));

    const bullAbsorption=c.delta<-avgAbsDelta*1.12&&closeNearHigh&&lowerWick>body*0.85;
    const bearAbsorption=c.delta>avgAbsDelta*1.12&&closeNearLow&&upperWick>body*0.85;

    const bullSweepReclaim=c.low<prevLow-avgRange*0.23&&c.close>prevLow&&closeNearHigh;
    const bearSweepReclaim=c.high>prevHigh+avgRange*0.23&&c.close<prevHigh&&closeNearLow;

    const bullDiv=c.low<=prevLow+s.cfg.tickSize*1.3&&cvdNow>prevCvdLow+avgAbsDelta*1.15&&c.close>=c.open;
    const bearDiv=c.high>=prevHigh-s.cfg.tickSize*1.3&&cvdNow<prevCvdHigh-avgAbsDelta*1.15&&c.close<=c.open;

    const bullContinuation=c.delta>avgAbsDelta*1.35&&c.close>prevHigh+s.cfg.tickSize*0.8&&c.totalVol>avgVol*0.95;
    const bearContinuation=c.delta<-avgAbsDelta*1.35&&c.close<prevLow-s.cfg.tickSize*0.8&&c.totalVol>avgVol*0.95;

    const buyerNoFollow=c.delta>avgAbsDelta*1.05&&c.close<c.open&&c.high>=prevHigh;
    const sellerNoFollow=c.delta<-avgAbsDelta*1.05&&c.close>c.open&&c.low<=prevLow;

    let bullScore=0;const bullReasons=[];
    if(bullSweepReclaim){bullScore+=30;bullReasons.push('Sweep reclaim');}
    if(bullAbsorption){bullScore+=26;bullReasons.push('Absorption');}
    if(bullDiv){bullScore+=22;bullReasons.push('CVD divergence');}
    if(bullContinuation){bullScore+=18;bullReasons.push('Aggressive continuation');}
    if(sellerNoFollow){bullScore+=14;bullReasons.push('Seller failure');}
    if(nearSupport){bullScore+=12;bullReasons.push('At support zone');}
    if(nearResistance){bullScore-=8;}

    let bearScore=0;const bearReasons=[];
    if(bearSweepReclaim){bearScore+=30;bearReasons.push('Sweep reject');}
    if(bearAbsorption){bearScore+=26;bearReasons.push('Absorption');}
    if(bearDiv){bearScore+=22;bearReasons.push('CVD divergence');}
    if(bearContinuation){bearScore+=18;bearReasons.push('Aggressive continuation');}
    if(buyerNoFollow){bearScore+=14;bearReasons.push('Buyer failure');}
    if(nearResistance){bearScore+=12;bearReasons.push('At resistance zone');}
    if(nearSupport){bearScore-=8;}

    const bullCore=bullSweepReclaim||bullAbsorption||bullDiv||bullContinuation||sellerNoFollow;
    const bearCore=bearSweepReclaim||bearAbsorption||bearDiv||bearContinuation||buyerNoFollow;

    if(bullCore&&bullScore>=44&&bullScore>=bearScore+8&&i-lastSignalBar.buy>=2){
      signals.push({id:`${s.symbol}-${timeframeKey}-buy-${c.ts}`,ts:c.ts,side:'buy',price:c.close,score:Math.round(bullScore),reasons:bullReasons,source:'confluence'});
      lastSignalBar.buy=i;
    }else if(bearCore&&bearScore>=44&&bearScore>=bullScore+8&&i-lastSignalBar.sell>=2){
      signals.push({id:`${s.symbol}-${timeframeKey}-sell-${c.ts}`,ts:c.ts,side:'sell',price:c.close,score:Math.round(bearScore),reasons:bearReasons,source:'confluence'});
      lastSignalBar.sell=i;
    }
  }
  const timeframeMs=TIMEFRAME_LOOKUP[timeframeKey]?.ms||60000;
  const merged=[...signals];

  for(const alert of s.alerts.slice(-80)){
    if(alert.bias!=='bullish'&&alert.bias!=='bearish'){continue;}
    const side=alert.bias==='bullish'?'buy':'sell';
    const score=alert.severity==='high'?78:62;
    const price=Number.isFinite(alert.price)?alert.price:nearestCandlePrice(candles,alert.ts,candles[candles.length-1]?.close);
    const duplicate=merged.some((sig)=>sig.side===side&&Math.abs(sig.ts-alert.ts)<timeframeMs*0.7);
    if(duplicate){continue;}
    merged.push({id:`${alert.id}-sig`,ts:alert.ts,side,price,score,reasons:[alert.type],source:'detector'});
  }

  merged.sort((a,b)=>a.ts-b.ts);
  pruneByLength(merged,MAX_SIGNALS_DETAIL);
  return merged;
}

function buildZoneHints(s){
  const candles=buildCandlesFromFrame(s,'5m',140);
  const model=buildZoneModel(candles,s.cfg,s.lastPrice);
  return{nearestSupport:model.support[0]||null,nearestResistance:model.resistance[0]||null};
}

function buildSymbolSummary(s,now){
  const zoneHints=buildZoneHints(s);
  return{
    symbol:s.symbol,
    price:s.lastPrice,
    cvd:s.cvd,
    spreadPct:s.spreadPct,
    bidLiquidity:s.topBidQty5,
    askLiquidity:s.topAskQty5,
    delta15s:s.tradeWindow.filter((t)=>now-t.ts<=15000).reduce((sum,t)=>sum+t.deltaQty,0),
    alerts:s.alerts.slice(-30).reverse(),
    zones:zoneHints,
  };
}

function buildDetail(s,timeframeKey){
  const candles=buildCandlesFromFrame(s,timeframeKey,MAX_BARS_DETAIL);
  const cvd=candles.map((c)=>({ts:c.ts,value:c.cvdClose}));
  const bubbles=[];
  const orderBook=buildOrderBookDetail(s);
  const volumeProfile=buildVolumeProfile(s,candles,orderBook);

  for(const c of candles){
    const levels=[...c.levels.entries()]
      .map(([k,v])=>({
        price:Number(k),buy:v.buy,sell:v.sell,delta:v.delta,total:v.total,
        imbalance:Math.max(v.buy,v.sell)/Math.max(1e-9,Math.min(v.buy,v.sell)),
      }))
      .filter((x)=>x.total>0)
      .sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta))
      .slice(0,BUBBLES_PER_BAR);

    for(const l of levels){
      bubbles.push({
        ts:c.ts,price:l.price,buy:l.buy,sell:l.sell,delta:l.delta,absDelta:Math.abs(l.delta),
        total:l.total,imbalance:l.imbalance,side:l.delta>=0?'buy':'sell',
      });
    }
  }

  if(bubbles.length>MAX_BUBBLES_DETAIL){bubbles.splice(0,bubbles.length-MAX_BUBBLES_DETAIL);}

  const cleanCandles=candles.map((c)=>({
    ts:c.ts,open:c.open,high:c.high,low:c.low,close:c.close,buyVol:c.buyVol,sellVol:c.sellVol,totalVol:c.totalVol,delta:c.delta,
  }));

  const zones=buildZoneModel(cleanCandles,s.cfg,s.lastPrice);
  const signals=computeConfluenceSignals(s,timeframeKey,cleanCandles,cvd,zones);

  return{symbol:s.symbol,timeframe:timeframeKey,candles:cleanCandles,cvd,bubbles,zones,signals,orderBook,volumeProfile};
}
function normalizeSubscription(msg){
  const requestedSymbol=typeof msg.symbol==='string'?msg.symbol:DEFAULT_SYMBOL;
  const requestedTimeframe=typeof msg.timeframe==='string'?msg.timeframe:DEFAULT_TIMEFRAME;
  const symbol=state[requestedSymbol]?requestedSymbol:DEFAULT_SYMBOL;
  const timeframe=TIMEFRAME_LOOKUP[requestedTimeframe]?requestedTimeframe:DEFAULT_TIMEFRAME;
  return{symbol,timeframe};
}

const app=express();
app.use(express.static(path.join(__dirname,'public')));
app.get('/health',(_req,res)=>{
  const now=Date.now();
  const ageMs=(ts)=>ts?Math.max(0,now-ts):null;
  const symbols=Object.fromEntries(
    Object.values(state).map((s)=>[
      s.symbol,
      {
        price:s.lastPrice,
        orderBookLevels:(s.orderBook?.bids?.length||0)+(s.orderBook?.asks?.length||0),
        tradeAgeMs:ageMs(s.lastTradeUpdateTs),
        depthAgeMs:ageMs(s.lastDepthUpdateTs),
      },
    ]),
  );
  res.json({
    ok:true,
    ts:now,
    binanceSource:getActiveBinanceSource().name,
    commit:process.env.RENDER_GIT_COMMIT||process.env.RENDER_GIT_COMMIT_SHA||null,
    symbols,
  });
});

const server=http.createServer(app);
const wss=new WebSocket.Server({server});

function sendSnapshot(client,now,summary){
  const sub=client.subscription||{symbol:DEFAULT_SYMBOL,timeframe:DEFAULT_TIMEFRAME};
  const symbolState=state[sub.symbol]||state[DEFAULT_SYMBOL];
  const detail=buildDetail(symbolState,sub.timeframe);
  client.send(JSON.stringify({type:'snapshot',ts:now,summary,detail}));
}

wss.on('connection',(ws)=>{
  ws.subscription={symbol:DEFAULT_SYMBOL,timeframe:DEFAULT_TIMEFRAME};
  ws.send(JSON.stringify({
    type:'info',
    symbols:Object.keys(MARKETS),
    timeframes:TIMEFRAMES.map((t)=>t.key),
    defaults:{symbol:DEFAULT_SYMBOL,timeframe:DEFAULT_TIMEFRAME},
    binanceSymbols:Object.fromEntries(Object.entries(MARKETS).map(([symbol,cfg])=>[symbol,cfg.stream.toUpperCase()])),
  }));

  const now=Date.now();
  const summary=Object.fromEntries(Object.values(state).map((s)=>[s.symbol,buildSymbolSummary(s,now)]));
  sendSnapshot(ws,now,summary);

  ws.on('message',(raw)=>{
    let parsed;
    try{parsed=JSON.parse(raw.toString());}catch{return;}
    if(!parsed||parsed.type!=='subscribe'){return;}
    ws.subscription=normalizeSubscription(parsed);
    const immediateNow=Date.now();
    const immediateSummary=Object.fromEntries(Object.values(state).map((s)=>[s.symbol,buildSymbolSummary(s,immediateNow)]));
    sendSnapshot(ws,immediateNow,immediateSummary);
  });
});

function broadcastSnapshots(){
  const now=Date.now();
  const summary=Object.fromEntries(Object.values(state).map((s)=>[s.symbol,buildSymbolSummary(s,now)]));
  for(const client of wss.clients){if(client.readyState===WebSocket.OPEN){sendSnapshot(client,now,summary);}}
}

setInterval(()=>{
  const now=Date.now();
  Object.values(state).forEach((s)=>{
    pruneByAge(s.tradeWindow,now,20000);
    pruneByAge(s.priceWindow,now,70000);
    detectSweep(s,now);
    detectAbsorption(s,now);
  });
  broadcastSnapshots();
},SNAPSHOT_INTERVAL_MS);

function buildBinanceStreamUrl(){
  const src=getActiveBinanceSource();
  const streams=[];
  Object.values(MARKETS).forEach((cfg)=>{streams.push(`${cfg.stream}@aggTrade`);streams.push(`${cfg.stream}@depth20@100ms`);});
  return `${src.wsBase}/stream?streams=${streams.join('/')}`;
}

let binanceSocket=null;
let reconnectDelayMs=1500;
let binanceDataWatchdog=null;

function insertBar(frame, barTs, bar) {
  frame.bars.set(barTs, bar);
  frame.barKeys.push(barTs);
  if (frame.barKeys.length > MAX_BARS_PER_FRAME) {
    const oldest = frame.barKeys.shift();
    frame.bars.delete(oldest);
  }
}

async function fetchJsonWithFallback(pathname) {
  const sourceOrder=[activeBinanceSourceIndex,...BINANCE_SOURCES.map((_x,i)=>i).filter((i)=>i!==activeBinanceSourceIndex)];
  let lastErr=new Error(`request failed: ${pathname}`);

  for(const idx of sourceOrder){
    const src=BINANCE_SOURCES[idx];
    try{
      const body=await fetchJsonFromSource(src,pathname);
      if(idx!==activeBinanceSourceIndex){
        const prev=getActiveBinanceSource();
        activeBinanceSourceIndex=idx;
        const next=getActiveBinanceSource();
        console.log(`[binance] REST source switched ${prev.name} -> ${next.name}`);
      }
      return body;
    }catch(err){
      lastErr=new Error(`source ${src.name}: ${err.message}`);
    }
  }

  throw lastErr;
}

async function fetchJsonFromSource(src, pathname) {
  const url = `${src.restBase}${pathname}`;
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(),5000);
  try{
    const res = await fetch(url,{signal:controller.signal});
    if (!res.ok) {
      throw new Error(`http ${res.status}`);
    }
    return await res.json();
  }finally{
    clearTimeout(timeout);
  }
}

async function fetchKlines(binanceSymbol, interval, limit = 260) {
  const rows=await fetchJsonWithFallback(`/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`);
  if(!Array.isArray(rows)||rows.length===0){
    throw new Error(`klines ${binanceSymbol} ${interval} empty response`);
  }
  return rows;
}

async function fetchAggTradesPreferGlobal(binanceSymbol, limit = REST_RECENT_TRADES_LIMIT) {
  const preferredOrder=[
    ...BINANCE_SOURCES.map((_x,i)=>i).filter((i)=>BINANCE_SOURCES[i].name==='global'),
    ...BINANCE_SOURCES.map((_x,i)=>i).filter((i)=>BINANCE_SOURCES[i].name!=='global'),
  ];
  let lastErr=new Error(`aggTrades ${binanceSymbol} failed`);

  for(const idx of preferredOrder){
    const src=BINANCE_SOURCES[idx];
    try{
      const rows=await fetchJsonFromSource(src,`/api/v3/aggTrades?symbol=${binanceSymbol}&limit=${limit}`);
      if(!Array.isArray(rows)||rows.length===0){
        throw new Error('empty response');
      }
      return{rows,sourceIndex:idx};
    }catch(err){
      lastErr=new Error(`source ${src.name}: ${err.message}`);
    }
  }
  throw lastErr;
}

function seedFrameFromKlines(s, timeframeKey, rows) {
  const frame = s.frames[timeframeKey];
  frame.bars.clear();
  frame.barKeys = [];

  let runningCvd = 0;
  let lastClose = s.lastPrice;

  for (const row of rows) {
    const ts = Number(row[0]);
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const totalVol = Number(row[5]);
    const takerBuyVol = Number(row[9]);

    if (
      !Number.isFinite(ts) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      !Number.isFinite(totalVol) ||
      !Number.isFinite(takerBuyVol)
    ) {
      continue;
    }

    const buyVol = Math.max(0, takerBuyVol);
    const sellVol = Math.max(0, totalVol - buyVol);
    const delta = buyVol - sellVol;
    runningCvd += delta;
    lastClose = close;

    const level = roundToTick(close, s.cfg.tickSize);
    const levelKey = String(level);
    const levels = new Map();
    levels.set(levelKey, {
      buy: buyVol,
      sell: sellVol,
      delta,
      total: totalVol,
    });

    insertBar(frame, ts, {
      ts,
      open,
      high,
      low,
      close,
      buyVol,
      sellVol,
      totalVol,
      delta,
      cvdClose: runningCvd,
      levels,
    });
  }

  return { runningCvd, lastClose };
}

async function seedHistoricalData() {
  for (const [symbol, cfg] of Object.entries(MARKETS)) {
    const s = state[symbol];
    const binanceSymbol = cfg.stream.toUpperCase();
    let oneMinRows = null;

    for (const tf of TIMEFRAMES) {
      try {
        const rows = await fetchKlines(binanceSymbol, tf.key, 260);
        seedFrameFromKlines(s, tf.key, rows);
        if (tf.key === '1m') {
          oneMinRows = rows;
        }
      } catch (err) {
        console.error(`[seed] ${symbol} ${tf.key} failed:`, err.message);
      }
    }

    if (oneMinRows && oneMinRows.length > 0) {
      const series = [];
      let runningCvd = 0;
      for (const row of oneMinRows) {
        const ts = Number(row[0]);
        const close = Number(row[4]);
        const totalVol = Number(row[5]);
        const takerBuyVol = Number(row[9]);
        if (!Number.isFinite(ts) || !Number.isFinite(close) || !Number.isFinite(totalVol) || !Number.isFinite(takerBuyVol)) {
          continue;
        }
        const buyVol = Math.max(0, takerBuyVol);
        const sellVol = Math.max(0, totalVol - buyVol);
        const minuteDelta = buyVol - sellVol;
        runningCvd += minuteDelta;
        series.push({ ts, price: close, cvd: runningCvd, volume: totalVol, minuteDelta });
      }
      s.minuteSeries = series.slice(-MAX_MINUTE_SERIES);
      if (series.length > 0) {
        s.cvd = series[series.length - 1].cvd;
        s.lastPrice = series[series.length - 1].price;
      }
    }
  }
}

let restFallbackTimer=null;
let restFallbackInFlight=false;

function staleForRestFallback(s, now){
  const tradeAge=s.lastTradeUpdateTs>0?now-s.lastTradeUpdateTs:Infinity;
  const depthAge=s.lastDepthUpdateTs>0?now-s.lastDepthUpdateTs:Infinity;
  return{trade:tradeAge>REST_STALE_THRESHOLD_MS,depth:depthAge>REST_STALE_THRESHOLD_MS};
}

async function backfillTradesFromRest(s,cfg){
  const symbol=cfg.stream.toUpperCase();
  const {rows,sourceIndex}=await fetchAggTradesPreferGlobal(symbol,REST_RECENT_TRADES_LIMIT);
  const sourceName=BINANCE_SOURCES[sourceIndex]?.name||'global';
  if(!Array.isArray(rows)||rows.length===0){return;}
  const sorted=rows
    .map((t)=>({
      id:Number(t.a),
      price:Number(t.p),
      qty:Number(t.q),
      ts:Number(t.T),
      isBuyerMaker:Boolean(t.m),
    }))
    .filter((t)=>Number.isFinite(t.id)&&Number.isFinite(t.price)&&Number.isFinite(t.qty)&&t.qty>0&&Number.isFinite(t.ts))
    .sort((a,b)=>a.id-b.id);
  if(!sorted.length){return;}

  if(!s.lastRestTradeIds[sourceName]){
    s.lastRestTradeIds[sourceName]=sorted[0].id-1;
  }

  const lastId=s.lastRestTradeIds[sourceName]||0;
  let fresh=sorted.filter((t)=>t.id>lastId);
  if(!fresh.length&&s.lastTradeUpdateTs>0){
    fresh=sorted.filter((t)=>t.ts>s.lastTradeUpdateTs+1);
  }
  for(const trade of fresh){
    handleTrade({T:trade.ts,p:trade.price,q:trade.qty,m:trade.isBuyerMaker},s);
  }
  s.lastRestTradeIds[sourceName]=Math.max(lastId,sorted[sorted.length-1].id);
}

async function backfillDepthFromRest(s,cfg){
  const symbol=cfg.stream.toUpperCase();
  const depth=await fetchJsonWithFallback(`/api/v3/depth?symbol=${symbol}&limit=${ORDER_BOOK_LEVELS}`);
  if(!depth||!Array.isArray(depth.bids)||!Array.isArray(depth.asks)){return;}
  handleDepth({E:Date.now(),bids:depth.bids,asks:depth.asks},s);
}

async function pollRestFallback(){
  if(restFallbackInFlight){return;}
  restFallbackInFlight=true;
  const now=Date.now();
  try{
    for(const [symbol,cfg] of Object.entries(MARKETS)){
      const s=state[symbol];
      const stale=staleForRestFallback(s,now);
      if(stale.trade){
        try{await backfillTradesFromRest(s,cfg);}catch(err){console.error(`[fallback] ${symbol} trades: ${err.message}`);}
      }
      if(stale.depth){
        try{await backfillDepthFromRest(s,cfg);}catch(err){console.error(`[fallback] ${symbol} depth: ${err.message}`);}
      }
    }
  }finally{
    restFallbackInFlight=false;
  }
}

function startRestFallbackPoller(){
  if(restFallbackTimer){return;}
  restFallbackTimer=setInterval(()=>{
    pollRestFallback().catch((err)=>console.error('[fallback] poll error',err.message));
  },REST_FALLBACK_INTERVAL_MS);
}

function connectBinance(){
  const streamUrl=buildBinanceStreamUrl();
  binanceSocket=new WebSocket(streamUrl);
  let hasReceivedData=false;

  binanceSocket.on('open',()=>{
    reconnectDelayMs=1500;
    console.log(`[binance] connected to ${streamUrl}`);
    if(binanceDataWatchdog){clearTimeout(binanceDataWatchdog);}
    binanceDataWatchdog=setTimeout(()=>{
      if(!hasReceivedData){
        rotateBinanceSource('no stream data after connect');
        try{binanceSocket.close();}catch{}
      }
    },15000);
  });

  binanceSocket.on('message',(raw)=>{
    hasReceivedData=true;
    if(binanceDataWatchdog){clearTimeout(binanceDataWatchdog);binanceDataWatchdog=null;}
    let parsed;
    try{parsed=JSON.parse(raw.toString());}catch{return;}
    const stream=parsed.stream;const data=parsed.data;
    if(!stream||!data){return;}

    const [streamSymbol,channel]=stream.split('@');
    const symbol=STREAM_TO_SYMBOL[streamSymbol];
    if(!symbol){return;}

    const s=state[symbol];
    if(channel==='aggTrade'){handleTrade(data,s);}
    if(channel.startsWith('depth')){handleDepth(data,s);}
  });

  binanceSocket.on('close',()=>{
    if(binanceDataWatchdog){clearTimeout(binanceDataWatchdog);binanceDataWatchdog=null;}
    console.log('[binance] disconnected, reconnecting...');
    setTimeout(connectBinance,reconnectDelayMs);
    reconnectDelayMs=Math.min(reconnectDelayMs*1.7,15000);
  });

  binanceSocket.on('error',(err)=>{
    if(binanceDataWatchdog){clearTimeout(binanceDataWatchdog);binanceDataWatchdog=null;}
    console.error('[binance] error',err.message);
    try{binanceSocket.close();}catch{}
  });
}

server.listen(PORT,()=>{console.log(`Orderflow app running on http://localhost:${PORT}`);});
seedHistoricalData()
  .then(() => {
    console.log('[seed] historical bars loaded');
  })
  .catch((err) => {
    console.error('[seed] failed:', err.message);
  })
  .finally(() => {
    startRestFallbackPoller();
    connectBinance();
  });
