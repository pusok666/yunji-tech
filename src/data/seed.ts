import type { BusinessData, Order } from '../types.ts';
import { daysAgo, localDate } from '../lib/business.ts';
export function createSeed(): BusinessData {
  const names=['拾光创意工作室','青禾生活方式','山野咖啡','一木设计事务所','橙子数字传媒','见山文化','林间花艺','星河咨询','小满烘焙','墨白影像','好物研究所','沐光空间'];
  const contacts=['陈思远','林晓','许知南','周予安','王可欣','李沐','张雨晴','赵明','刘佳','孙浩','吴悦','郑宁'];
  const customers=names.map((name,i)=>({id:`CUS-${String(i+1).padStart(3,'0')}`,name,contact:contacts[i],phone:`1380010${String(1000+i).padStart(4,'0')}`,email:`contact${i+1}@example.com`,industry:['创意设计','生活零售','餐饮服务','专业服务'][i%4],level:(i%4===0?'重点客户':i%3===0?'潜在客户':'普通客户') as '重点客户'|'潜在客户'|'普通客户',date:daysAgo(i*5),notes:i===0?'长期品牌合作客户，每月沟通项目需求。':''}));
  const titles=['品牌视觉设计','企业官网搭建','社交媒体运营','文创周边采购','品牌策略咨询','产品摄影服务'];
  const categories=['设计服务','技术服务','运营服务','商品销售','咨询服务','设计服务'];
  const orders: Order[]=[];
  const now=new Date();
  for(let m=0;m<6;m++) for(let j=0;j<8;j++) {
    const idx=m*8+j; const lastDay=new Date(now.getFullYear(),now.getMonth()-m+1,0).getDate(); const date=localDate(new Date(now.getFullYear(),now.getMonth()-m,Math.min(lastDay,Math.max(1,now.getDate()-j*2))));
    const amount=[6800,12800,3600,2400,5000,4200,8800,1800][j];
    const status: Order['status']=m>0?'已完成':['进行中','进行中','已完成','待确认','已完成','进行中','已完成','已取消'][j] as Order['status'];
    const due=new Date(`${date}T12:00:00`);due.setDate(due.getDate()+14);
    orders.push({id:`YJ-${now.getFullYear()}-${String(1048-idx).padStart(4,'0')}`,customerId:customers[idx%12].id,title:titles[j%6],category:categories[j%6],amount,paidAmount:status==='已取消'?0:status==='待确认'?0:status==='进行中'?amount/2:amount,status,date,dueDate:localDate(due),notes:''});
  }
  const products=[['品牌文创礼盒','YJ-BOX-001','文创周边',48,15,268,120,'套'],['定制帆布袋','YJ-BAG-002','文创周边',8,20,49,18,'个'],['环保随行杯','YJ-CUP-003','生活好物',62,15,89,32,'个'],['创意便签套装','YJ-NOTE-004','办公用品',12,20,29,8,'套'],['桌面收纳盒','YJ-DESK-005','办公用品',35,10,69,25,'个'],['品牌画册','YJ-BOOK-006','印刷物料',120,30,35,12,'本'],['亚克力展示架','YJ-STAND-007','印刷物料',0,5,128,55,'个'],['极简帆布包','YJ-BAG-008','生活好物',27,10,129,45,'个']].map((p,i)=>({id:`PRD-${i+1}`,name:p[0] as string,sku:p[1] as string,category:p[2] as string,stock:p[3] as number,threshold:p[4] as number,price:p[5] as number,cost:p[6] as number,unit:p[7] as string,notes:''}));
  const transactions:BusinessData['transactions']=[];
  for(let m=0;m<6;m++) {
    const date=localDate(new Date(now.getFullYear(),now.getMonth()-m,1));
    [['办公空间租金','场地费用',3200],['物料与商品采购','采购成本',5800+m*200],['工具软件订阅','软件服务',680],['项目协作费用','人力成本',4500+m*300],['市场推广投放','营销费用',1200+m*100]].forEach((t,i)=>transactions.push({id:`FIN-${m}-${i}`,title:t[0] as string,type:'支出',category:t[1] as string,amount:t[2] as number,date,notes:''}));
  }
  return {version:1,customers,orders,products,transactions};
}
