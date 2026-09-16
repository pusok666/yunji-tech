import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart, BarChart, PieChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';
echarts.use([LineChart,BarChart,PieChart,GridComponent,TooltipComponent,LegendComponent,CanvasRenderer]);
export function Chart({option,height=280,label}:{option:EChartsCoreOption;height?:number;label:string}) {
  const el=useRef<HTMLDivElement>(null); const chart=useRef<echarts.EChartsType|null>(null);
  useEffect(()=>{if(!el.current)return;const instance=echarts.init(el.current);chart.current=instance;const resize=new ResizeObserver(()=>instance.resize());resize.observe(el.current);return()=>{resize.disconnect();instance.dispose();chart.current=null;};},[]);
  useEffect(()=>{chart.current?.setOption({...option,aria:{enabled:true}},true);},[option]);
  return <div className="chart" ref={el} style={{height}} role="img" aria-label={label}/>;
}
export const chartColors=['#3475f4','#23b7a1','#70a4ff','#a5d8ce','#f5bb69','#a695db'];
export const axisStyle={axisLine:{show:false},axisTick:{show:false},axisLabel:{color:'#8b96aa',fontSize:12},splitLine:{lineStyle:{color:'#eef1f6',type:'dashed'}}};
