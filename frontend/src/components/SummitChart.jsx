import { memo, forwardRef } from 'react';
import ReactECharts from 'echarts-for-react';

const SummitChart = forwardRef((props, ref) => {
  const {
    chartType,
    symbols,
    timeframe,
    isWhatIfMode,
    whatIfAmount,
    legendSelected,
    setLegendSelected,
    seriesMap = {},
    valueUnit = 'percent',
    isNormalized = false,
    seriesUnits = {},
    isLoading = false,
    pricePrefix = '',
    isExportMode = false
  } = props;

  // helpers

  const fmtPct   = (v) => v == null ? '' : `${Number(v).toFixed(2)}%`;
  const fmtPrice = (v) => v == null ? '' : `${pricePrefix}${Number(v).toFixed(2)}`;


  const safeSymbols = Array.isArray(symbols) ? symbols : [];
  const safeAmount  = Number(whatIfAmount) || 0;

  if (!safeSymbols.length) {
    return (
      <div className="text-sm text-slate-400 text-center py-10">
        Please look up a symbol to begin.
      </div>
    );
  }

  const onEvents = {
    legendselectchanged: (params) => {
      setLegendSelected?.((prev) => ({ ...prev, ...params.selected }));
    },
  };

  // 1) Build a unified series list first (apply What-If here if enabled)

// helper to get a unit per symbol (fallback: US* = percent, else price)
const unitOf = (n) => seriesUnits[n] || (n.startsWith('US') ? 'percent' : 'price');

// Apply What-If only to price series; percent series pass through unchanged
const canScale = isWhatIfMode && Number(whatIfAmount) > 0;

const seriesList = safeSymbols.map((name) => {
  const raw = Array.isArray(seriesMap[name]) 
    ? seriesMap[name] 
    : [];
  const unit = unitOf(name);

  if (canScale && unit === 'price' && raw.length) {
    const first = raw[0][1];
    const shares = first ? (Number(whatIfAmount) / first) : 0;
    return { name, unit, data: raw.map(([t, v]) => [t, v * shares]) };
  }

  return { name, unit, data: raw };
});


  // 2) Optional normalize to % change since first visible point
  function toPctChange(series) {
    if (!series?.length) return series;
    const base = series[0][1];
    if (base == null || base === 0) return series;
    return series.map(([t, v]) => [t, ((v - base) / base) * 100]);
  }

  const finalSeriesList = isNormalized
    ? seriesList.map(s => ({ ...s, unit: 'percent', data: toPctChange(s.data) }))
    : seriesList;

  // ---- decide axes (price LEFT, % RIGHT) & map series ---- (counts for 3 and 4)

// what units are present?
const hasPrice   = finalSeriesList.some(s => s.unit === 'price');
const hasPercent = finalSeriesList.some(s => s.unit === 'percent');

// dual only when not normalized and both units exist
const dual = !isNormalized && hasPrice && hasPercent;

// theme-aware ink
const css = getComputedStyle(document.documentElement);

const axisInk = isExportMode
  ? '#222222'
  : (css.getPropertyValue('--subtle') || '#cbd5e1').trim();

const gridInk = isExportMode
  ? '#cccccc'
  : (css.getPropertyValue('--border') || '#232a44').trim();

const textInk = isExportMode
  ? '#111111'
  : (css.getPropertyValue('--text') || '#eef2ff').trim();

// helper to build an axis; hide axis name when single-axis
const fmtAxis = (unit, pos, showName) => ({
  type: 'value',
  position: pos,                                // 'left' | 'right'
  name: showName ? (unit === 'price' ? (pricePrefix || '$') : '%') : undefined,
  nameTextStyle: { color: axisInk },
  axisLabel: { color: axisInk, formatter: unit === 'price' ? fmtPrice : fmtPct, fontSize: 12, show: true },
  axisLine:  { lineStyle: { color: gridInk } },
  axisTick:  { show: false },
  splitLine: { show: true, lineStyle: { color: gridInk, type: 'dashed' } },
});

// X axis (time) with readable ticks in dark mode
const xAxis = {
  type: 'time',
  axisLabel: { color: axisInk, fontSize: 12, show: true },
  axisLine:  { lineStyle: { color: gridInk } },
  axisTick:  { show: false },
  splitLine: { show: true, lineStyle: { color: gridInk, type: 'dashed' } },
};


// yAxis: single % when normalized; else dual if mixed; else single price or %
const yAxis = isNormalized
  ? [fmtAxis('percent', 'left', false)]
  : dual
    ? [fmtAxis('price', 'left', true), fmtAxis('percent', 'right', true)]
    : [fmtAxis(hasPrice ? 'price' : 'percent', 'left', false)];


// series: send each series to the correct axis
const series = finalSeriesList.map(s => ({
  name: s.name,
  type: chartType,
  data: Array.isArray(s.data) ? s.data : [],
  showSymbol: false,
  connectNulls: true,
  yAxisIndex: (isNormalized || !dual) ? 0 : (s.unit === 'price' ? 0 : 1),
}));

  // 5) Tooltip that formats by unit
  const tooltip = {
    trigger: 'axis',
    formatter: (ps = []) => {
      if (!ps.length) return '';
      const head = new Date(ps[0].axisValue).toISOString().slice(0,19).replace('T',' ');
      const lines = ps.map(p => {
        const unit = isNormalized
          ? 'percent'
          : (finalSeriesList.find(s => s.name === p.seriesName)?.unit || 'price');
        const val  = unit === 'percent' ? fmtPct(p.data?.[1]) : fmtPrice(p.data?.[1]);
        return `${p.marker} ${p.seriesName} <b>${val}</b>`;
      });
      return [head, ...lines].join('<br/>');
    },
  };

  const option = {
    tooltip: {
    trigger: 'axis',
    backgroundColor: css.getPropertyValue('--card').trim() || '#12172a',
    borderColor: gridInk,
    textStyle: { color: textInk },
    axisPointer: {
      type: 'cross',
      lineStyle: { color: gridInk },
      crossStyle: { color: gridInk },
      label: { color: css.getPropertyValue('--card').trim() || '#12172a', backgroundColor: textInk }
    }},
    legend: { data: safeSymbols, selected: legendSelected, selectedMode: 'multiple', top: 0, textStyle: { color: textInk, fontSize: 12 }, icon:'circle',},
    xAxis,
    yAxis,
    series,
    grid: { left: 60, right: 40, top: 20, bottom: 40, containLabel: true },
  };

  return (
    <div className="max-w-5xl">
      <ReactECharts
        ref={ref}
        key={`${timeframe}-${chartType}-${isNormalized}-${safeSymbols.join(',')}-${pricePrefix}-${isExportMode}`}
        option={option}
        onEvents={onEvents}
        style={{ height: '400px', width: '100%' }}
        lazyUpdate={false}
        notMerge={true}
        showLoading={isLoading || !(option?.series && option.series.length)}
        loadingOption={{
          text: 'Loading…',
          maskColor: 'rgba(255,255,255,0.6)',
        }}
      />
    </div>
  );
});

// memo
const areEqual = (prev, next) => {
  if (prev.pricePrefix !== next.pricePrefix) return false;
  if (prev.currency !== next.currency) return false;
  if (prev.chartType !== next.chartType) return false;
  if (prev.timeframe !== next.timeframe) return false;
  if (prev.isWhatIfMode !== next.isWhatIfMode) return false;
  if (prev.whatIfAmount !== next.whatIfAmount) return false;
  if (prev.valueUnit !== next.valueUnit) return false;
  if (prev.isNormalized !== next.isNormalized) return false;

  const a = prev.symbols || [], b = next.symbols || [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;

  if (prev.seriesMap !== next.seriesMap) return false;
  if (prev.seriesUnits !== next.seriesUnits) return false;

  return true;
};

export default memo(SummitChart, areEqual);
