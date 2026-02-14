const state={
  selectedSymbol:'BTCUSD',
  selectedTimeframe:'1m',
  symbols:[],
  timeframes:[],
  defaults:{symbol:'BTCUSD',timeframe:'1m'},
  summary:{},
  priceMoves:{},
  detail:null,
  ws:null,
};

const tvChart={
  root:document.getElementById('orderflowChart'),
  wrap:document.querySelector('.canvas-wrap'),
  chart:null,
  candleSeries:null,
  overlayCanvas:document.getElementById('footprintOverlay'),
  overlayCtx:null,
  overlayDetail:null,
  overlayScheduled:false,
  zoneLines:[],
  patternLines:[],
  lastPriceLine:null,
  hasFittedOnce:false,
  lastSymbol:'',
  lastTimeframe:'',
  currentDigits:null,
  realtimePulsePhase:0,
  lastCandleTime:null,
};

const connectionStatusEl=document.getElementById('connectionStatus');
const symbolTabsEl=document.getElementById('symbolTabs');
const timeframeTabsEl=document.getElementById('timeframeTabs');
const metricPriceEl=document.getElementById('metricPrice');
const metricPriceMoveEl=document.getElementById('metricPriceMove');
const metricCvdEl=document.getElementById('metricCvd');
const metricDeltaEl=document.getElementById('metricDelta');
const metricSpreadEl=document.getElementById('metricSpread');
const metricBidLiqEl=document.getElementById('metricBidLiq');
const metricAskLiqEl=document.getElementById('metricAskLiq');
const metricSupportEl=document.getElementById('metricSupport');
const metricResistanceEl=document.getElementById('metricResistance');
const finalSignalCardEl=document.getElementById('finalSignalCard');
const finalSignalSideEl=document.getElementById('finalSignalSide');
const finalSignalConfidenceEl=document.getElementById('finalSignalConfidence');
const finalSignalMetaEl=document.getElementById('finalSignalMeta');
const alertsListEl=document.getElementById('alertsList');
const orderBookSpreadEl=document.getElementById('orderBookSpread');
const orderBookImbalanceEl=document.getElementById('orderBookImbalance');
const orderBookSpeedEl=document.getElementById('orderBookSpeed');
const orderBookAsksEl=document.getElementById('orderBookAsks');
const orderBookBidsEl=document.getElementById('orderBookBids');
const vpPocEl=document.getElementById('vpPoc');
const vpValueAreaEl=document.getElementById('vpValueArea');
const vpDeltaEl=document.getElementById('vpDelta');
const vpBinSizeEl=document.getElementById('vpBinSize');
const vpTotalVolumeEl=document.getElementById('vpTotalVolume');
const volumeProfileRowsEl=document.getElementById('volumeProfileRows');
const chartTitleEl=document.getElementById('chartTitle');
const chartTimeZoneEl=document.getElementById('chartTimeZone');

const IST_TIMEZONE='Asia/Kolkata';
const IST_TIME_FORMATTER=new Intl.DateTimeFormat('en-IN',{
  timeZone:IST_TIMEZONE,
  hour:'2-digit',
  minute:'2-digit',
  second:'2-digit',
  hour12:false,
});
const IST_DATE_TIME_FORMATTER=new Intl.DateTimeFormat('en-IN',{
  timeZone:IST_TIMEZONE,
  day:'2-digit',
  month:'short',
  hour:'2-digit',
  minute:'2-digit',
  hour12:false,
});
const IST_DATE_FORMATTER=new Intl.DateTimeFormat('en-IN',{
  timeZone:IST_TIMEZONE,
  day:'2-digit',
  month:'short',
});
const IST_HOUR_FORMATTER=new Intl.DateTimeFormat('en-IN',{
  timeZone:IST_TIMEZONE,
  hour:'2-digit',
  hour12:false,
});

function fmt(value,digits=2){
  if(!Number.isFinite(value)){return '-';}
  return Number(value).toLocaleString(undefined,{minimumFractionDigits:digits,maximumFractionDigits:digits});
}

function fmtShort(value){
  if(!Number.isFinite(value)){return '-';}
  const abs=Math.abs(value);
  if(abs>=1_000_000_000){return `${(value/1_000_000_000).toFixed(2)}B`;}
  if(abs>=1_000_000){return `${(value/1_000_000).toFixed(2)}M`;}
  if(abs>=1_000){return `${(value/1_000).toFixed(2)}K`;}
  return value.toFixed(2);
}

function chartTimeToDate(time){
  if(typeof time==='number'&&Number.isFinite(time)){return new Date(time*1000);}
  if(time&&typeof time==='object'&&Number.isFinite(time.year)&&Number.isFinite(time.month)&&Number.isFinite(time.day)){
    return new Date(Date.UTC(time.year,time.month-1,time.day));
  }
  return null;
}

function formatChartTimeIst(time,withDate=false){
  const d=chartTimeToDate(time);
  if(!d){return '';}
  return withDate?IST_DATE_TIME_FORMATTER.format(d):IST_TIME_FORMATTER.format(d);
}

function setStatus(text,cls){
  connectionStatusEl.textContent=text;
  connectionStatusEl.className=`chip ${cls}`;
}

function sendSubscription(){
  if(!state.ws||state.ws.readyState!==WebSocket.OPEN){return;}
  state.ws.send(JSON.stringify({type:'subscribe',symbol:state.selectedSymbol,timeframe:state.selectedTimeframe}));
}

function makeSymbolTabs(){
  symbolTabsEl.innerHTML='';
  state.symbols.forEach((symbol)=>{
    const btn=document.createElement('button');
    btn.type='button';
    btn.className=`symbol-btn ${state.selectedSymbol===symbol?'active':''}`;
    btn.textContent=symbol;
    btn.onclick=()=>{
      state.selectedSymbol=symbol;
      makeSymbolTabs();
      sendSubscription();
      render();
    };
    symbolTabsEl.appendChild(btn);
  });
}

function makeTimeframeTabs(){
  timeframeTabsEl.innerHTML='';
  state.timeframes.forEach((tf)=>{
    const btn=document.createElement('button');
    btn.type='button';
    btn.className=`timeframe-btn ${state.selectedTimeframe===tf?'active':''}`;
    btn.textContent=tf;
    btn.onclick=()=>{
      state.selectedTimeframe=tf;
      makeTimeframeTabs();
      sendSubscription();
      render();
    };
    timeframeTabsEl.appendChild(btn);
  });
}

function zoneLabel(zone){
  if(!zone){return '-';}
  return `${fmt(zone.priceLow,zone.priceLow<1?5:2)} - ${fmt(zone.priceHigh,zone.priceHigh<1?5:2)}`;
}

function computePriceMoves(prevSummary,nextSummary,previousMoves){
  const moves={...(previousMoves||{})};
  Object.entries(nextSummary||{}).forEach(([symbol,next])=>{
    const currentPrice=next?.price;
    const previousPrice=prevSummary?.[symbol]?.price;
    if(Number.isFinite(currentPrice)&&Number.isFinite(previousPrice)&&previousPrice!==0){
      const delta=currentPrice-previousPrice;
      moves[symbol]={delta,pct:(delta/previousPrice)*100};
      return;
    }
    if(Number.isFinite(currentPrice)&&!moves[symbol]){
      moves[symbol]={delta:0,pct:0};
    }
  });
  return moves;
}

function renderMetrics(summary,priceMove){
  if(!summary){
    metricPriceEl.textContent='-';
    metricPriceMoveEl.textContent='-';
    metricCvdEl.textContent='-';
    metricDeltaEl.textContent='-';
    metricSpreadEl.textContent='-';
    metricBidLiqEl.textContent='-';
    metricAskLiqEl.textContent='-';
    metricSupportEl.textContent='-';
    metricResistanceEl.textContent='-';
    metricPriceEl.className='';
    metricPriceMoveEl.className='metric-sub neutral';
    return;
  }

  const priceDigits=summary.price<1?5:2;
  metricPriceEl.textContent=fmt(summary.price,priceDigits);
  metricCvdEl.textContent=fmtShort(summary.cvd);
  metricDeltaEl.textContent=fmtShort(summary.delta15s);
  metricSpreadEl.textContent=fmt(summary.spreadPct*100,4);
  metricBidLiqEl.textContent=fmtShort(summary.bidLiquidity);
  metricAskLiqEl.textContent=fmtShort(summary.askLiquidity);
  metricSupportEl.textContent=zoneLabel(summary.zones?.nearestSupport);
  metricResistanceEl.textContent=zoneLabel(summary.zones?.nearestResistance);
  metricDeltaEl.className=summary.delta15s>=0?'bull':'bear';

  if(!priceMove||!Number.isFinite(priceMove.delta)||!Number.isFinite(priceMove.pct)){
    metricPriceEl.className='';
    metricPriceMoveEl.textContent='-';
    metricPriceMoveEl.className='metric-sub neutral';
  }else if(Math.abs(priceMove.delta)<1e-12){
    metricPriceEl.className='';
    metricPriceMoveEl.textContent='No change';
    metricPriceMoveEl.className='metric-sub neutral';
  }else{
    const up=priceMove.delta>0;
    const direction=up?'UP':'DOWN';
    const signedDelta=`${up?'+':''}${fmt(priceMove.delta,priceDigits)}`;
    const signedPct=`${up?'+':''}${fmt(priceMove.pct,3)}%`;
    metricPriceEl.className=up?'bull':'bear';
    metricPriceMoveEl.textContent=`${direction} ${signedDelta} (${signedPct})`;
    metricPriceMoveEl.className=`metric-sub ${up?'bull':'bear'}`;
  }
}

function renderFinalSignal(decision){
  if(!finalSignalCardEl||!finalSignalSideEl||!finalSignalConfidenceEl||!finalSignalMetaEl){return;}

  const safe=decision&&typeof decision==='object'?decision:{};
  const rawSide=String(safe.side||'wait').toLowerCase();
  const side=rawSide==='buy'||rawSide==='sell'?rawSide:'wait';
  const confidence=Number.isFinite(safe.confidence)?Math.max(0,Math.min(100,Math.round(safe.confidence))):0;
  const buyScore=Number.isFinite(safe.buyScore)?safe.buyScore:0;
  const sellScore=Number.isFinite(safe.sellScore)?safe.sellScore:0;
  const reasons=Array.isArray(safe.reasons)?safe.reasons.filter((x)=>typeof x==='string'&&x.trim()):[];
  const ts=Number.isFinite(safe.ts)?safe.ts:Date.now();

  finalSignalCardEl.className=`final-signal-card ${side}`;
  finalSignalSideEl.textContent=side.toUpperCase();
  finalSignalConfidenceEl.textContent=`${confidence}%`;

  const headline=`Buy ${fmt(buyScore,1)} / Sell ${fmt(sellScore,1)}`;
  const reasonText=reasons.slice(0,2).join(' | ');
  const stamp=`${IST_TIME_FORMATTER.format(new Date(ts))} IST`;
  finalSignalMetaEl.textContent=reasonText?`${headline} | ${reasonText} | ${stamp}`:`${headline} | ${stamp}`;
}

function renderAlerts(alerts){
  const list=alerts||[];
  alertsListEl.innerHTML='';
  if(list.length===0){
    const empty=document.createElement('div');
    empty.className='empty';
    empty.textContent='No live alerts yet for this symbol.';
    alertsListEl.appendChild(empty);
    return;
  }

  list.forEach((alert)=>{
    const wrap=document.createElement('article');
    wrap.className=`alert ${alert.severity||'medium'}`;

    const meta=document.createElement('div');
    meta.className='meta';

    const left=document.createElement('span');
    left.textContent=`${alert.type} - ${String(alert.bias||'').toUpperCase()}`;

    const right=document.createElement('span');
    right.textContent=`${IST_TIME_FORMATTER.format(new Date(alert.ts))} IST`;

    meta.append(left,right);

    const text=document.createElement('div');
    text.className='text';
    text.textContent=alert.message;

    wrap.append(meta,text);
    alertsListEl.appendChild(wrap);
  });
}

function renderOrderBook(orderBook,summary){
  if(!orderBook||!Array.isArray(orderBook.bids)||!Array.isArray(orderBook.asks)||orderBook.bids.length===0||orderBook.asks.length===0){
    orderBookSpreadEl.textContent='Spread -';
    orderBookImbalanceEl.textContent='Imbalance -';
    orderBookImbalanceEl.className='legend-item';
    orderBookSpeedEl.textContent='Speed -';
    orderBookAsksEl.innerHTML='<div class="book-empty">Waiting for depth...</div>';
    orderBookBidsEl.innerHTML='<div class="book-empty">Waiting for depth...</div>';
    return;
  }

  const referencePrice=summary?.price??orderBook.midPrice??1;
  const priceDigits=referencePrice<1?5:2;
  orderBookSpreadEl.textContent=`Spread ${fmt(orderBook.spread,priceDigits)} (${fmt(orderBook.spreadPct*100,4)}%)`;

  const imbalance=Number.isFinite(orderBook.imbalance)?orderBook.imbalance:0;
  orderBookImbalanceEl.textContent=`Imbalance ${imbalance>=0?'+':''}${fmt(imbalance*100,2)}%`;
  orderBookImbalanceEl.className='legend-item';
  if(imbalance>0.03){orderBookImbalanceEl.classList.add('bull');}
  if(imbalance<-0.03){orderBookImbalanceEl.classList.add('bear');}

  const flowOfi=summary?.ofi10s;
  const flowTfi=summary?.tfi10s;
  const qtr=summary?.quoteTradeRatio30s;
  const dispersion=Number.isFinite(orderBook.depthDispersion)?orderBook.depthDispersion:summary?.depthDispersion;
  const flowText=Number.isFinite(flowOfi)&&Number.isFinite(flowTfi)?` OFI ${fmt(flowOfi,0)} / TFI ${fmt(flowTfi,0)}`:'';
  const qtrText=Number.isFinite(qtr)?` | Q/T ${fmt(qtr,2)}`:'';
  const dispersionText=Number.isFinite(dispersion)?` | Disp ${fmt(dispersion,2)}`:'';
  orderBookSpeedEl.textContent=`Speed ${fmt(orderBook.speed,2)} upd/s${flowText}${qtrText}${dispersionText}`;
  const maxQty=Math.max(1,orderBook.maxQty||1);

  function buildRows(levels,side){
    return levels.map((row)=>{
      const width=Math.max(2,Math.min(100,(row.qty/maxQty)*100));
      return `<div class="book-row ${side}">
        <span class="book-depth" style="width:${width.toFixed(2)}%"></span>
        <span class="book-price">${fmt(row.price,priceDigits)}</span>
        <span class="book-qty">${fmtShort(row.qty)}</span>
        <span class="book-cum">${fmtShort(row.cumulative)}</span>
      </div>`;
    }).join('');
  }

  orderBookAsksEl.innerHTML=buildRows([...(orderBook.asks||[])].reverse(),'ask');
  orderBookBidsEl.innerHTML=buildRows(orderBook.bids||[],'bid');
}

function renderVolumeProfile(profile,summary){
  if(!profile||!Array.isArray(profile.rows)||profile.rows.length===0){
    vpPocEl.textContent='POC -';
    vpValueAreaEl.textContent='VA -';
    vpDeltaEl.textContent='Profile Delta -';
    vpDeltaEl.className='legend-item';
    vpBinSizeEl.textContent='Bin -';
    vpTotalVolumeEl.textContent='Total -';
    volumeProfileRowsEl.innerHTML='<div class="book-empty">Waiting for profile...</div>';
    return;
  }

  const referencePrice=summary?.price??profile.poc?.price??1;
  const priceDigits=referencePrice<1?5:2;
  vpPocEl.textContent=profile.poc?`POC ${fmt(profile.poc.price,priceDigits)}`:'POC -';

  if(Number.isFinite(profile.valueArea?.low)&&Number.isFinite(profile.valueArea?.high)){
    vpValueAreaEl.textContent=`VA ${fmt(profile.valueArea.low,priceDigits)} - ${fmt(profile.valueArea.high,priceDigits)}`;
  }else{
    vpValueAreaEl.textContent='VA -';
  }

  const profileDelta=profile.stats?.delta;
  vpDeltaEl.textContent=`Profile Delta ${fmtShort(profileDelta)}`;
  vpDeltaEl.className='legend-item';
  if(profileDelta>0){vpDeltaEl.classList.add('bull');}
  if(profileDelta<0){vpDeltaEl.classList.add('bear');}

  vpBinSizeEl.textContent=`Bin ${fmt(profile.binSize,priceDigits)}`;
  vpTotalVolumeEl.textContent=`Total ${fmtShort(profile.stats?.totalVolume)}`;

  const visibleRows=profile.rows.slice(0,56);
  const maxShare=Math.max(1e-9,...visibleRows.map((r)=>r.share||0));
  const header='<div class="vp-row vp-header"><span>Price</span><span>Distribution</span><span>Total</span><span>Delta</span><span>Live LQ</span></div>';
  const rowsHtml=visibleRows.map((row)=>{
    const width=Math.max(2,Math.min(100,((row.share||0)/maxShare)*100));
    const buyRatio=row.total>0?Math.max(0,row.buy/row.total):0;
    const sellRatio=row.total>0?Math.max(0,row.sell/row.total):0;
    const buyWidth=width*buyRatio;
    const sellWidth=width*sellRatio;
    const liveBook=row.bookTotal||0;
    const classes=[
      'vp-row',
      row.isPoc?'vp-poc':'',
      row.inValueArea?'vp-va':'',
      row.delta>0?'vp-bull':'',
      row.delta<0?'vp-bear':'',
      liveBook>0?'vp-live':'',
    ].filter(Boolean).join(' ');

    return `<div class="${classes}">
      <span class="vp-price">${fmt(row.price,priceDigits)}</span>
      <span class="vp-bar-wrap">
        <span class="vp-bar vp-sell" style="width:${sellWidth.toFixed(2)}%"></span>
        <span class="vp-bar vp-buy" style="width:${buyWidth.toFixed(2)}%"></span>
      </span>
      <span class="vp-total">${fmtShort(row.total)}</span>
      <span class="vp-delta">${fmtShort(row.delta)}</span>
      <span class="vp-book ${liveBook>0?'live':''}" title="Bid ${fmtShort(row.bookBid||0)} / Ask ${fmtShort(row.bookAsk||0)}">${fmtShort(liveBook)}</span>
    </div>`;
  }).join('');

  volumeProfileRowsEl.innerHTML=header+rowsHtml;
}

function renderChartTitle(summary){
  if(chartTitleEl){
    chartTitleEl.textContent=`${state.selectedSymbol} Orderflow Chart (${state.selectedTimeframe})`;
  }
  if(chartTimeZoneEl){
    chartTimeZoneEl.textContent=`Time Zone: IST (Asia/Kolkata) ${IST_TIME_FORMATTER.format(new Date())}`;
  }
}

function lightweight(){
  return window.LightweightCharts||null;
}

function addSeriesCompat(chart,seriesType,options,paneIndex){
  const L=lightweight();
  if(!chart||!L){return null;}

  if(typeof chart.addSeries==='function'&&L[seriesType]){
    try{return chart.addSeries(L[seriesType],options||{},paneIndex);}catch{}
    try{return chart.addSeries(L[seriesType],options||{});}catch{}
  }

  const legacy={
    CandlestickSeries:'addCandlestickSeries',
    LineSeries:'addLineSeries',
    HistogramSeries:'addHistogramSeries',
  };

  const method=legacy[seriesType];
  if(method&&typeof chart[method]==='function'){
    return chart[method](options||{});
  }
  return null;
}

function setSeriesMarkersCompat(series,markers){
  const L=lightweight();
  if(!series){return;}

  if(typeof series.setMarkers==='function'){
    series.setMarkers(markers);
    return;
  }

  if(L&&typeof L.createSeriesMarkers==='function'){
    if(series.__markerApi&&typeof series.__markerApi.setMarkers==='function'){
      series.__markerApi.setMarkers(markers);
    }else{
      series.__markerApi=L.createSeriesMarkers(series,markers);
    }
  }
}

function msToSec(ms){
  return Math.floor(ms/1000);
}

function resizeFootprintOverlay(){
  if(!tvChart.overlayCanvas||!tvChart.wrap){return;}
  const dpr=window.devicePixelRatio||1;
  const width=Math.max(1,Math.floor(tvChart.wrap.clientWidth));
  const height=Math.max(1,Math.floor(tvChart.wrap.clientHeight));
  tvChart.overlayCanvas.width=Math.floor(width*dpr);
  tvChart.overlayCanvas.height=Math.floor(height*dpr);
  tvChart.overlayCanvas.style.width=`${width}px`;
  tvChart.overlayCanvas.style.height=`${height}px`;
  tvChart.overlayCtx=tvChart.overlayCanvas.getContext('2d');
  if(tvChart.overlayCtx){tvChart.overlayCtx.setTransform(dpr,0,0,dpr,0,0);}
}

function drawFootprintOverlay(detail){
  const canvas=tvChart.overlayCanvas;
  const ctx=tvChart.overlayCtx;
  if(!canvas||!ctx){return;}
  const width=canvas.clientWidth||0;
  const height=canvas.clientHeight||0;
  ctx.clearRect(0,0,width,height);

  if(!detail||!Array.isArray(detail.bubbles)||detail.bubbles.length===0||!tvChart.chart||!tvChart.candleSeries){return;}
  const maxAbs=Math.max(1,...detail.bubbles.map((b)=>b.absDelta||Math.abs(b.delta)||1));
  const bubbles=detail.bubbles.slice(-1800);
  const currentBarTs=detail?.candles?.[detail.candles.length-1]?.ts??null;

  for(const b of bubbles){
    if(currentBarTs&&b.ts===currentBarTs){continue;}
    const x=tvChart.chart.timeScale().timeToCoordinate(msToSec(b.ts));
    const y=tvChart.candleSeries.priceToCoordinate(b.price);
    if(!Number.isFinite(x)||!Number.isFinite(y)){continue;}
    if(x<-20||x>width+20||y<-20||y>height+20){continue;}

    const absDelta=b.absDelta||Math.abs(b.delta)||1;
    const strength=Math.max(0.08,Math.min(1,Math.sqrt(absDelta/maxAbs)));
    const rx=3+strength*11;
    const ry=2.5+strength*8.5;
    const buy=b.side==='buy';
    const rgb=buy?'22,163,74':'220,38,38';

    const glow=ctx.createRadialGradient(x,y,1,x,y,rx*1.7);
    glow.addColorStop(0,`rgba(${rgb},${0.18+strength*0.22})`);
    glow.addColorStop(1,`rgba(${rgb},0)`);
    ctx.fillStyle=glow;
    ctx.beginPath();
    ctx.arc(x,y,rx*1.7,0,Math.PI*2);
    ctx.fill();

    ctx.fillStyle=`rgba(${rgb},${0.12+strength*0.24})`;
    ctx.fillRect(x-rx,y-ry,rx*2,ry*2);
    ctx.strokeStyle=`rgba(${rgb},${0.20+strength*0.30})`;
    ctx.lineWidth=1;
    ctx.strokeRect(x-rx,y-ry,rx*2,ry*2);
  }

  const lastCandle=detail?.candles?.[detail.candles.length-1];
  if(lastCandle){
    const x=tvChart.chart.timeScale().timeToCoordinate(msToSec(lastCandle.ts));
    const y=tvChart.candleSeries.priceToCoordinate(lastCandle.close);
    if(Number.isFinite(x)&&Number.isFinite(y)){
      const pulse=4+Math.abs(Math.sin(Date.now()/280))*5;
      ctx.beginPath();
      ctx.arc(x,y,pulse,0,Math.PI*2);
      ctx.fillStyle='rgba(59,130,246,0.22)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(x,y,2.4,0,Math.PI*2);
      ctx.fillStyle='rgba(59,130,246,0.90)';
      ctx.fill();
    }
  }
}

function requestFootprintOverlayDraw(){
  if(tvChart.overlayScheduled){return;}
  tvChart.overlayScheduled=true;
  requestAnimationFrame(()=>{
    tvChart.overlayScheduled=false;
    drawFootprintOverlay(tvChart.overlayDetail);
  });
}

function clearZoneLines(){
  if(!tvChart.candleSeries){return;}
  tvChart.zoneLines.forEach((line)=>{
    try{tvChart.candleSeries.removePriceLine(line);}catch{}
  });
  tvChart.zoneLines=[];
}

function applyZoneLines(zones){
  if(!tvChart.candleSeries){return;}
  clearZoneLines();

  const supports=(zones?.support||[]).slice(0,3);
  const resistances=(zones?.resistance||[]).slice(0,3);

  supports.forEach((z,idx)=>{
    const line=tvChart.candleSeries.createPriceLine({
      price:z.center,
      color:'rgba(22,163,74,0.72)',
      lineWidth:1,
      lineStyle:2,
      axisLabelVisible:true,
      title:`S${idx+1}`,
    });
    tvChart.zoneLines.push(line);
  });

  resistances.forEach((z,idx)=>{
    const line=tvChart.candleSeries.createPriceLine({
      price:z.center,
      color:'rgba(220,38,38,0.72)',
      lineWidth:1,
      lineStyle:2,
      axisLabelVisible:true,
      title:`R${idx+1}`,
    });
    tvChart.zoneLines.push(line);
  });
}

function clearPatternLines(){
  if(!tvChart.candleSeries){return;}
  tvChart.patternLines.forEach((line)=>{
    try{tvChart.candleSeries.removePriceLine(line);}catch{}
  });
  tvChart.patternLines=[];
}

function applyPatternAnnotations(patterns){
  if(!tvChart.candleSeries){return;}
  clearPatternLines();
  const recent=(patterns||[]).slice(-3);

  recent.forEach((p)=>{
    const side=p.side==='buy'?'buy':'sell';
    const color=side==='buy'?'rgba(14,116,144,0.82)':'rgba(185,28,28,0.82)';
    const zoneColor=side==='buy'?'rgba(14,116,144,0.36)':'rgba(185,28,28,0.36)';

    if(Number.isFinite(p.breakoutPrice)){
      const boLine=tvChart.candleSeries.createPriceLine({
        price:p.breakoutPrice,
        color,
        lineWidth:2,
        lineStyle:1,
        axisLabelVisible:true,
        title:`${p.short||'PAT'} BO`,
      });
      tvChart.patternLines.push(boLine);
    }

    if(Number.isFinite(p.zoneHigh)){
      const zhLine=tvChart.candleSeries.createPriceLine({
        price:p.zoneHigh,
        color:zoneColor,
        lineWidth:1,
        lineStyle:2,
        axisLabelVisible:false,
        title:'',
      });
      tvChart.patternLines.push(zhLine);
    }

    if(Number.isFinite(p.zoneLow)){
      const zlLine=tvChart.candleSeries.createPriceLine({
        price:p.zoneLow,
        color:zoneColor,
        lineWidth:1,
        lineStyle:2,
        axisLabelVisible:false,
        title:'',
      });
      tvChart.patternLines.push(zlLine);
    }
  });
}

function updateLastPriceLine(price){
  if(!tvChart.candleSeries){return;}
  if(tvChart.lastPriceLine){
    try{tvChart.candleSeries.removePriceLine(tvChart.lastPriceLine);}catch{}
    tvChart.lastPriceLine=null;
  }
  if(!Number.isFinite(price)){return;}
  tvChart.lastPriceLine=tvChart.candleSeries.createPriceLine({
    price,
    color:'rgba(59,130,246,0.86)',
    lineWidth:1,
    lineStyle:0,
    axisLabelVisible:true,
    title:'Last',
  });
}

function initChart(){
  if(tvChart.chart||!tvChart.root){return;}
  const L=lightweight();
  if(!L||typeof L.createChart!=='function'){return;}

  tvChart.chart=L.createChart(tvChart.root,{
    autoSize:true,
    attributionLogo:false,
    layout:{
      background:{type:'solid',color:'#ffffff'},
      textColor:'#334155',
      fontFamily:'IBM Plex Mono, monospace',
      fontSize:11,
      attributionLogo:false,
    },
    grid:{
      vertLines:{color:'rgba(148,163,184,0.22)'},
      horzLines:{color:'rgba(148,163,184,0.22)'},
    },
    rightPriceScale:{
      visible:true,
      borderColor:'#d8e3f0',
      scaleMargins:{top:0.06,bottom:0.10},
    },
    localization:{
      locale:'en-IN',
      timeFormatter:(time)=>formatChartTimeIst(time,false),
    },
    timeScale:{
      borderColor:'#d8e3f0',
      rightOffset:18,
      barSpacing:8,
      minBarSpacing:3,
      timeVisible:true,
      secondsVisible:false,
      fixLeftEdge:false,
      fixRightEdge:false,
      tickMarkFormatter:(time,tickMarkType)=>{
        const isDateTick=tickMarkType==='DayOfMonth'||tickMarkType==='Month'||tickMarkType==='Year'||tickMarkType===0||tickMarkType===1||tickMarkType===2;
        if(isDateTick){
          return formatChartTimeIst(time,true);
        }
        const d=chartTimeToDate(time);
        if(!d){return '';}
        const hour=Number(IST_HOUR_FORMATTER.format(d));
        return hour===0?IST_DATE_FORMATTER.format(d):IST_TIME_FORMATTER.format(d);
      },
    },
    crosshair:{
      mode:0,
      vertLine:{color:'rgba(71,85,105,0.65)',labelBackgroundColor:'#0f172a'},
      horzLine:{color:'rgba(71,85,105,0.65)',labelBackgroundColor:'#0f172a'},
    },
    handleScroll:{mouseWheel:true,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:true},
    handleScale:{
      axisPressedMouseMove:{time:true,price:true},
      mouseWheel:true,
      pinch:true,
    },
  });
  try{tvChart.chart.applyOptions({layout:{attributionLogo:false}});}catch{}

  tvChart.candleSeries=addSeriesCompat(tvChart.chart,'CandlestickSeries',{
    upColor:'#0f766e',
    downColor:'#dc2626',
    wickUpColor:'#0f766e',
    wickDownColor:'#dc2626',
    borderVisible:false,
    lastValueVisible:true,
    priceLineVisible:false,
  },0);

  const resize=()=>{
    if(!tvChart.chart||!tvChart.root){return;}
    if(typeof tvChart.chart.applyOptions==='function'){
      tvChart.chart.applyOptions({
        width:Math.max(320,Math.floor(tvChart.root.clientWidth)),
        height:Math.max(260,Math.floor(tvChart.root.clientHeight)),
      });
    }
    resizeFootprintOverlay();
    requestFootprintOverlayDraw();
  };

  window.addEventListener('resize',resize);
  resize();

  if(tvChart.chart?.timeScale&&typeof tvChart.chart.timeScale().subscribeVisibleLogicalRangeChange==='function'){
    tvChart.chart.timeScale().subscribeVisibleLogicalRangeChange(()=>{requestFootprintOverlayDraw();});
  }
  ['wheel','mousemove','mousedown','mouseup','touchmove'].forEach((evt)=>{
    if(tvChart.wrap){tvChart.wrap.addEventListener(evt,()=>{requestFootprintOverlayDraw();},{passive:true});}
  });

  tvChart.root.addEventListener('dblclick',()=>{
    if(tvChart.chart&&tvChart.chart.timeScale){
      tvChart.chart.timeScale().fitContent();
    }
    requestFootprintOverlayDraw();
  });
}

function renderChart(detail,summary){
  initChart();
  if(!tvChart.chart||!tvChart.candleSeries){return;}

  const candles=detail?.candles||[];

  if(candles.length===0){
    tvChart.candleSeries.setData([]);
    setSeriesMarkersCompat(tvChart.candleSeries,[]);
    clearZoneLines();
    clearPatternLines();
    updateLastPriceLine(null);
    tvChart.lastCandleTime=null;
    tvChart.overlayDetail=null;
    requestFootprintOverlayDraw();
    return;
  }

  const referencePrice=summary?.price??candles[candles.length-1]?.close??1;
  const priceDigits=referencePrice<1?5:2;
  if(tvChart.currentDigits!==priceDigits){
    tvChart.currentDigits=priceDigits;
    tvChart.candleSeries.applyOptions({
      priceFormat:{type:'price',precision:priceDigits,minMove:Math.pow(10,-priceDigits)},
    });
  }

  const candleData=candles.map((c)=>({
    time:msToSec(c.ts),
    open:c.open,
    high:c.high,
    low:c.low,
    close:c.close,
  }));
  const symbolChanged=tvChart.lastSymbol!==detail?.symbol;
  const tfChanged=tvChart.lastTimeframe!==detail?.timeframe;
  const mustResetSeries=!tvChart.hasFittedOnce||symbolChanged||tfChanged||tvChart.lastCandleTime===null;

  if(mustResetSeries){
    tvChart.candleSeries.setData(candleData);
    tvChart.lastCandleTime=candleData[candleData.length-1]?.time??null;
  }else{
    const lastBar=candleData[candleData.length-1];
    if(lastBar){
      if(tvChart.lastCandleTime!==lastBar.time&&candleData.length>2){
        tvChart.candleSeries.setData(candleData.slice(-260));
      }else{
        tvChart.candleSeries.update(lastBar);
      }
      tvChart.lastCandleTime=lastBar.time;
    }
  }

  const signalMarkers=(detail?.signals||[])
    .slice(-120)
    .map((sig)=>({
      time:msToSec(sig.ts),
      position:sig.side==='buy'?'belowBar':'aboveBar',
      color:sig.side==='buy'?'#16a34a':'#dc2626',
      shape:sig.side==='buy'?'arrowUp':'arrowDown',
      text:`${sig.side==='buy'?'B':'S'}${Number.isFinite(sig.score)?` ${sig.score}`:''}`,
    }));
  const patternMarkers=(detail?.patterns||[])
    .slice(-60)
    .filter((p)=>Number.isFinite(p.breakoutTs))
    .map((p)=>({
      time:msToSec(p.breakoutTs),
      position:p.side==='buy'?'belowBar':'aboveBar',
      color:p.side==='buy'?'#0369a1':'#b91c1c',
      shape:'square',
      text:p.label||`${p.short||'PAT'} BO`,
    }));
  const markers=[...signalMarkers,...patternMarkers];
  setSeriesMarkersCompat(tvChart.candleSeries,markers);

  applyZoneLines(detail?.zones);
  applyPatternAnnotations(detail?.patterns);
  updateLastPriceLine(candles[candles.length-1]?.close);

  if(!tvChart.hasFittedOnce||symbolChanged||tfChanged){
    tvChart.chart.timeScale().fitContent();
    tvChart.hasFittedOnce=true;
  }else{
    try{
      const logical=tvChart.chart.timeScale().getVisibleLogicalRange();
      if(logical&&logical.to>=candleData.length-8){
        tvChart.chart.timeScale().scrollToRealTime();
      }
    }catch{}
  }

  tvChart.lastSymbol=detail?.symbol||tvChart.lastSymbol;
  tvChart.lastTimeframe=detail?.timeframe||tvChart.lastTimeframe;
  tvChart.overlayDetail=detail;
  requestFootprintOverlayDraw();
}

function render(){
  const summary=state.summary[state.selectedSymbol];
  const priceMove=state.priceMoves[state.selectedSymbol];
  const detailReady=Boolean(state.detail&&state.detail.symbol===state.selectedSymbol&&state.detail.timeframe===state.selectedTimeframe);
  const activeDetail=detailReady?state.detail:null;

  renderChartTitle(summary);
  renderMetrics(summary,priceMove);
  renderFinalSignal(activeDetail?.decision);
  renderAlerts(summary?.alerts||[]);
  renderOrderBook(activeDetail?.orderBook,summary);
  renderVolumeProfile(activeDetail?.volumeProfile,summary);
  renderChart(activeDetail,summary);
}

function connect(){
  const protocol=window.location.protocol==='https:'?'wss':'ws';
  const ws=new WebSocket(`${protocol}://${window.location.host}`);
  state.ws=ws;

  ws.onopen=()=>{
    setStatus('Live','chip-ok');
    sendSubscription();
  };

  ws.onclose=()=>{
    setStatus('Disconnected','chip-error');
    setTimeout(connect,1500);
  };

  ws.onerror=()=>{
    setStatus('Error','chip-error');
  };

  ws.onmessage=(event)=>{
    let msg;
    try{msg=JSON.parse(event.data);}catch{return;}

    if(msg.type==='info'){
      state.symbols=msg.symbols||[];
      state.timeframes=msg.timeframes||[];
      state.defaults=msg.defaults||state.defaults;

      if(!state.symbols.includes(state.selectedSymbol)){
        state.selectedSymbol=state.defaults.symbol||state.symbols[0]||'BTCUSD';
      }
      if(!state.timeframes.includes(state.selectedTimeframe)){
        state.selectedTimeframe=state.defaults.timeframe||state.timeframes[0]||'1m';
      }

      makeSymbolTabs();
      makeTimeframeTabs();
      sendSubscription();
      render();
      return;
    }

    if(msg.type==='snapshot'){
      const nextSummary=msg.summary||state.summary;
      state.priceMoves=computePriceMoves(state.summary,nextSummary,state.priceMoves);
      state.summary=nextSummary;
      state.detail=msg.detail||null;
      render();
    }
  };
}

initChart();
connect();
