//+------------------------------------------------------------------+
//| LadderManager.mqh  v3.0 (s6: BE pull-back, new ladder at BE,    |
//|                    state/command files for Gold Replay live)     |
//| Manages the trades YOU open, grouped into ladders (max 3).       |
//| Per ladder: SL/TP sync, lot cap, stages 1-3. All from AVERAGE.   |
//| Stage 1 : MOVE TO BE button -> SL = average entry + buffer pips, |
//|           allowed only once price is +BEMinPips from average     |
//| Stage 2 : auto at avg +S2TrigPips -> SL = avg +S2LockPips        |
//|           (average is frozen here for stage 3)                   |
//| Stage 3 : auto at avg +S3TrigPips -> SL = avg +S3LockPips        |
//| After stage 3 the runner is yours: the EA moves no more SL.      |
//| Manual always wins: the EA only moves the SL at its own events   |
//| and only when its level is better than the SL you have.         |
//| New ladder only when every open ladder reached stage 2 and is   |
//| risk-free.                                                      |
//| State survives restart (terminal global variables).             |
//| v2.2: one journal row per closed ladder -> LM_journal.csv       |
//+------------------------------------------------------------------+
#ifndef LADDERMANAGER_MQH
#define LADDERMANAGER_MQH

#include <Trade/Trade.mqh>

#define LM_MAX 3
#define LM_VERSION "3.0-s6"
#define LM_JFILE "LM_journal.csv"

struct LMPos
{
   ulong  ticket;
   int    side;      // 0 buy, 1 sell
   double entry;
   double vol;
   double sl;
   double tp;
   long   timeMsc;
};

//+------------------------------------------------------------------+
class CLadder
{
public:
   int      id;          // 0 = free slot
   int      side;        // 0 buy, 1 sell, -1 not known yet (empty ladder)
   ulong    all[];       // every ticket that ever belonged (for the result)
   ulong    tk[];        // open tickets known to sync
   double   ksl[];
   double   ktp[];
   double   mSL, mTP;    // ladder SL/TP (master)
   bool     hasSL, hasTP;
   int      stage;       // 0 waiting, 2 stage 2 done, 3 stage 3 done (runner is yours)
   double   anchor;      // average entry, frozen at stage 2
   double   target;      // auto SL of the last stage reached
   double   pending;     // auto SL not yet fully applied (0 = none)
   double   next;        // stage 3 trigger price (set at stage 2)
   int      steps;       // unused since v3 (no trail), kept for saved state
   datetime start;
   datetime fail;
   double   logWait;
   bool     restored;
   bool     syncLogWait; // one "cannot take" line per value
   //--- journal (v2.2), saved with the ladder
   double   jBalBefore;  // balance at the first fill
   double   jFirstSL;    // first ladder SL seen (0 = none yet)
   double   jRisk1;      // IF SL HITS when the first SL was seen
   double   jRiskMax;    // worst IF SL HITS seen
   bool     jRiskSeen;
   double   jLotsTotal;  // sum of all fill volumes
   double   jLotsMax;    // largest volume open at one moment
   double   jWorst;      // last worst entry (manager's definition)
   double   jMfe, jMae;  // best / worst move from worst entry, $ of price
   bool     jMoveSeen;
   int      jSlEdits;    // your SL edits
   bool     jSlWidened;  // an edit moved the SL away from price
   datetime jS2Time;     // stage 2 time
   int      jAutoRef;    // auto SL refused by the broker
   double   jRefLast;    // last refused auto SL value (not saved)
   bool     jRestarted;  // restored from global variables
   int      jNo;         // rank when it opened (1 = L1)
   bool     jBePulled;   // s6: MOVE TO BE pulled a better SL back to BE (not saved)

   void Reset()
   {
      id=0; side=-1;
      ArrayResize(all,0); ArrayResize(tk,0); ArrayResize(ksl,0); ArrayResize(ktp,0);
      mSL=0; mTP=0; hasSL=false; hasTP=false;
      stage=0; anchor=0; target=0; pending=0; next=0; steps=0;
      start=0; fail=0; logWait=-1; restored=false; syncLogWait=false;
      jBalBefore=0; jFirstSL=0; jRisk1=0; jRiskMax=0; jRiskSeen=false;
      jLotsTotal=0; jLotsMax=0; jWorst=0; jMfe=0; jMae=0; jMoveSeen=false;
      jSlEdits=0; jSlWidened=false; jS2Time=0; jAutoRef=0; jRefLast=0;
      jRestarted=false; jNo=0; jBePulled=false;
   }
   bool Owns(ulong t)
   {
      for(int i=0;i<ArraySize(all);i++) if(all[i]==t) return true;
      return false;
   }
   void AddAll(ulong t)
   {
      if(Owns(t)) return;
      int n=ArraySize(all); ArrayResize(all,n+1); all[n]=t;
   }
   int Find(ulong t)
   {
      for(int i=0;i<ArraySize(tk);i++) if(tk[i]==t) return i;
      return -1;
   }
   int AddKnown(ulong t,double sl,double tp)
   {
      int n=ArraySize(tk);
      ArrayResize(tk,n+1); ArrayResize(ksl,n+1); ArrayResize(ktp,n+1);
      tk[n]=t; ksl[n]=sl; ktp[n]=tp;
      return n;
   }
   void RemoveKnown(int i)
   {
      int last=ArraySize(tk)-1;
      tk[i]=tk[last]; ksl[i]=ksl[last]; ktp[i]=ktp[last];
      ArrayResize(tk,last); ArrayResize(ksl,last); ArrayResize(ktp,last);
   }
};

//+------------------------------------------------------------------+
class CLadderManager
{
private:
   CTrade  m_trade;
   CLadder m_L[LM_MAX];
   int     m_counter;        // last ladder id used
   int     m_cur;            // slot receiving new trades (-1 none)
   int     m_page;           // slot shown on the panel
   ulong   m_unmanaged[];    // opposite-direction tickets already reported
   string  m_jq[];           // journal rows not written yet (file locked)
   string  m_jqTag[];        // "L1 BUY +$41.20" for the saved line
   bool    m_jWaitLog;       // "JOURNAL waiting" already printed
   uint    m_jTry;           // last write attempt (GetTickCount)

   //--- small helpers ------------------------------------------------
   double N(double p)        { return NormalizeDouble(p,_Digits); }
   string Px(double p)       { return p>0 ? DoubleToString(p,_Digits) : "none"; }
   string Lots(double v)     { return DoubleToString(v,2); }
   double Eps()              { return _Point*0.5; }
   bool   Same(double a,double b) { return MathAbs(a-b)<Eps(); }
   string SideName(int s)    { return s==0 ? "BUY" : (s==1 ? "SELL" : "-"); }
   int    Rank(int slot)     // 1 = oldest open ladder
   {
      int r=0;
      for(int i=0;i<LM_MAX;i++) if(m_L[i].id>0 && m_L[i].id<=m_L[slot].id) r++;
      return r;
   }
   string LN(int slot)       { return "L"+(string)Rank(slot); }
   string Tag(int slot)      { return LN(slot)+" "+SideName(m_L[slot].side); }
   string Money(double v)    { return (v>=0 ? "+$" : "-$")+DoubleToString(MathAbs(v),2); }
   int    Dir(int side)      { return side==1 ? -1 : 1; }
   bool   Better(int side,double a,double b)   // a is a better (tighter-in-profit) SL than b
   {
      if(b<=0) return a>0;
      return side==0 ? a>b+Eps() : a<b-Eps();
   }
   bool MagicOK(long magic)
   {
      if(MagicFilter<0) return true;
      return magic==MagicFilter;
   }
   double NormLotDown(double v)
   {
      double st=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_STEP);
      if(st<=0) st=0.01;
      return NormalizeDouble(MathFloor(v/st+1e-9)*st,2);
   }
   double PriceNow(int side)
   {
      return side==0 ? SymbolInfoDouble(_Symbol,SYMBOL_BID) : SymbolInfoDouble(_Symbol,SYMBOL_ASK);
   }
   double StopDist()
   {
      long lv=MathMax(SymbolInfoInteger(_Symbol,SYMBOL_TRADE_STOPS_LEVEL),
                      SymbolInfoInteger(_Symbol,SYMBOL_TRADE_FREEZE_LEVEL));
      return lv*_Point;
   }
   bool SLValidNow(int side,double sl)
   {
      if(sl<=0) return true;
      if(side==0) return sl <= SymbolInfoDouble(_Symbol,SYMBOL_BID)-StopDist();
      return sl >= SymbolInfoDouble(_Symbol,SYMBOL_ASK)+StopDist();
   }
   bool TPValidNow(int side,double tp)
   {
      if(tp<=0) return true;
      if(side==0) return tp >= SymbolInfoDouble(_Symbol,SYMBOL_BID)+StopDist();
      return tp <= SymbolInfoDouble(_Symbol,SYMBOL_ASK)-StopDist();
   }

   //--- persistence --------------------------------------------------
   string GP()                         { return "LM."+_Symbol+"."; }
   string GL(int id,string key)        { return GP()+"L"+(string)id+"."+key; }
   string GT(ulong t)                  { return GP()+"t"+(string)t; }

   void SaveMeta()
   {
      GlobalVariableSet(GP()+"counter",m_counter);
      GlobalVariableSet(GP()+"cur",m_cur>=0 ? m_L[m_cur].id : 0);
   }
   void SaveLadder(int slot)
   {
      if(m_L[slot].id<=0) return;
      int id=m_L[slot].id;
      GlobalVariableSet(GL(id,"side"),   m_L[slot].side);
      GlobalVariableSet(GL(id,"stage"),  m_L[slot].stage);
      GlobalVariableSet(GL(id,"anchor"), m_L[slot].anchor);
      GlobalVariableSet(GL(id,"target"), m_L[slot].target);
      GlobalVariableSet(GL(id,"pending"),m_L[slot].pending);
      GlobalVariableSet(GL(id,"next"),   m_L[slot].next);
      GlobalVariableSet(GL(id,"steps"),  m_L[slot].steps);
      GlobalVariableSet(GL(id,"start"),  (double)m_L[slot].start);
      GlobalVariableSet(GL(id,"msl"),    m_L[slot].mSL);
      GlobalVariableSet(GL(id,"mtp"),    m_L[slot].mTP);
      GlobalVariableSet(GL(id,"hsl"),    m_L[slot].hasSL?1:0);
      GlobalVariableSet(GL(id,"htp"),    m_L[slot].hasTP?1:0);
      SaveJournal(slot);
   }
   void SaveJournal(int slot)
   {
      if(m_L[slot].id<=0) return;
      int id=m_L[slot].id;
      GlobalVariableSet(GL(id,"bb"),  m_L[slot].jBalBefore);
      GlobalVariableSet(GL(id,"fsl"), m_L[slot].jFirstSL);
      GlobalVariableSet(GL(id,"r1"),  m_L[slot].jRisk1);
      GlobalVariableSet(GL(id,"rmax"),m_L[slot].jRiskMax);
      GlobalVariableSet(GL(id,"rsn"), m_L[slot].jRiskSeen?1:0);
      GlobalVariableSet(GL(id,"lt"),  m_L[slot].jLotsTotal);
      GlobalVariableSet(GL(id,"lmx"), m_L[slot].jLotsMax);
      GlobalVariableSet(GL(id,"wst"), m_L[slot].jWorst);
      GlobalVariableSet(GL(id,"mfe"), m_L[slot].jMfe);
      GlobalVariableSet(GL(id,"mae"), m_L[slot].jMae);
      GlobalVariableSet(GL(id,"msn"), m_L[slot].jMoveSeen?1:0);
      GlobalVariableSet(GL(id,"sle"), m_L[slot].jSlEdits);
      GlobalVariableSet(GL(id,"slw"), m_L[slot].jSlWidened?1:0);
      GlobalVariableSet(GL(id,"s2t"), (double)m_L[slot].jS2Time);
      GlobalVariableSet(GL(id,"asr"), m_L[slot].jAutoRef);
      GlobalVariableSet(GL(id,"rst"), m_L[slot].jRestarted?1:0);
      GlobalVariableSet(GL(id,"no"),  m_L[slot].jNo);
   }
   void DeleteLadderSaved(int slot)
   {
      int id=m_L[slot].id;
      string keys[]={"side","stage","anchor","target","pending","next","steps","start","msl","mtp","hsl","htp",
                     "bb","fsl","r1","rmax","rsn","lt","lmx","wst","mfe","mae","msn","sle","slw","s2t","asr","rst","no"};
      for(int i=0;i<ArraySize(keys);i++) GlobalVariableDel(GL(id,keys[i]));
      for(int i=0;i<ArraySize(m_L[slot].all);i++) GlobalVariableDel(GT(m_L[slot].all[i]));
   }
   void LoadAll()
   {
      string gp=GP();
      if(GlobalVariableCheck(gp+"counter")) m_counter=(int)GlobalVariableGet(gp+"counter");
      int curId=GlobalVariableCheck(gp+"cur") ? (int)GlobalVariableGet(gp+"cur") : 0;

      // ladders
      int total=GlobalVariablesTotal();
      for(int i=0;i<total;i++)
      {
         string name=GlobalVariableName(i);
         if(StringFind(name,gp+"L")!=0) continue;
         int dot=StringFind(name,".side");
         if(dot<0 || dot+5!=StringLen(name)) continue;
         int id=(int)StringToInteger(StringSubstr(name,StringLen(gp)+1,dot-StringLen(gp)-1));
         if(id<=0) continue;
         int slot=FreeSlot();
         if(slot<0) break;
         m_L[slot].Reset();
         m_L[slot].id     =id;
         m_L[slot].side   =(int)GlobalVariableGet(GL(id,"side"));
         m_L[slot].stage  =(int)GlobalVariableGet(GL(id,"stage"));
         m_L[slot].anchor =GlobalVariableGet(GL(id,"anchor"));
         m_L[slot].target =GlobalVariableGet(GL(id,"target"));
         m_L[slot].pending=GlobalVariableGet(GL(id,"pending"));
         m_L[slot].next   =GlobalVariableGet(GL(id,"next"));
         m_L[slot].steps  =(int)GlobalVariableGet(GL(id,"steps"));
         m_L[slot].start  =(datetime)GlobalVariableGet(GL(id,"start"));
         m_L[slot].mSL    =GlobalVariableGet(GL(id,"msl"));
         m_L[slot].mTP    =GlobalVariableGet(GL(id,"mtp"));
         m_L[slot].hasSL  =GlobalVariableGet(GL(id,"hsl"))>0.5;
         m_L[slot].hasTP  =GlobalVariableGet(GL(id,"htp"))>0.5;
         m_L[slot].restored=true;
         m_L[slot].jBalBefore=GlobalVariableGet(GL(id,"bb"));
         m_L[slot].jFirstSL  =GlobalVariableGet(GL(id,"fsl"));
         m_L[slot].jRisk1    =GlobalVariableGet(GL(id,"r1"));
         m_L[slot].jRiskMax  =GlobalVariableGet(GL(id,"rmax"));
         m_L[slot].jRiskSeen =GlobalVariableGet(GL(id,"rsn"))>0.5;
         m_L[slot].jLotsTotal=GlobalVariableGet(GL(id,"lt"));
         m_L[slot].jLotsMax  =GlobalVariableGet(GL(id,"lmx"));
         m_L[slot].jWorst    =GlobalVariableGet(GL(id,"wst"));
         m_L[slot].jMfe      =GlobalVariableGet(GL(id,"mfe"));
         m_L[slot].jMae      =GlobalVariableGet(GL(id,"mae"));
         m_L[slot].jMoveSeen =GlobalVariableGet(GL(id,"msn"))>0.5;
         m_L[slot].jSlEdits  =(int)GlobalVariableGet(GL(id,"sle"));
         m_L[slot].jSlWidened=GlobalVariableGet(GL(id,"slw"))>0.5;
         m_L[slot].jS2Time   =(datetime)GlobalVariableGet(GL(id,"s2t"));
         m_L[slot].jAutoRef  =(int)GlobalVariableGet(GL(id,"asr"));
         m_L[slot].jNo       =(int)GlobalVariableGet(GL(id,"no"));
         m_L[slot].jRestarted=(GlobalVariableGet(GL(id,"rst"))>0.5 || MarkRestart);
         if(id==curId) m_cur=slot;
         if(id>m_counter) m_counter=id;
      }
      // ticket ownership
      total=GlobalVariablesTotal();
      for(int i=0;i<total;i++)
      {
         string name=GlobalVariableName(i);
         if(StringFind(name,gp+"t")!=0) continue;
         ulong t=(ulong)StringToInteger(StringSubstr(name,StringLen(gp)+1));
         int id=(int)GlobalVariableGet(name);
         int slot=SlotOfId(id);
         if(slot>=0 && t>0) m_L[slot].AddAll(t);
      }
      if(m_cur<0) m_cur=NewestActive(-1);
      m_page=(m_cur>=0 ? m_cur : NewestActive(-1));
   }

   int FreeSlot()
   {
      for(int i=0;i<LM_MAX;i++) if(m_L[i].id==0) return i;
      return -1;
   }
   int SlotOfId(int id)
   {
      for(int i=0;i<LM_MAX;i++) if(m_L[i].id==id && id>0) return i;
      return -1;
   }
   int OwnerSlot(ulong t)
   {
      for(int i=0;i<LM_MAX;i++) if(m_L[i].id>0 && m_L[i].Owns(t)) return i;
      return -1;
   }
   int NewestActive(int exclude)
   {
      int best=-1;
      for(int i=0;i<LM_MAX;i++)
         if(i!=exclude && m_L[i].id>0 && (best<0 || m_L[i].id>m_L[best].id)) best=i;
      return best;
   }
   int ActiveCount()
   {
      int c=0; for(int i=0;i<LM_MAX;i++) if(m_L[i].id>0) c++; return c;
   }
   bool IsReported(ulong t)
   {
      for(int i=0;i<ArraySize(m_unmanaged);i++) if(m_unmanaged[i]==t) return true;
      return false;
   }

   //--- snapshot of managed positions, oldest first ------------------
   int Snapshot(LMPos &p[])
   {
      ArrayResize(p,0);
      for(int i=0;i<PositionsTotal();i++)
      {
         ulong k=PositionGetTicket(i);
         if(k==0 || !PositionSelectByTicket(k)) continue;
         if(PositionGetString(POSITION_SYMBOL)!=_Symbol) continue;
         if(!MagicOK(PositionGetInteger(POSITION_MAGIC))) continue;
         LMPos x;
         x.ticket =k;
         x.side   =(PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY ? 0 : 1);
         x.entry  =PositionGetDouble(POSITION_PRICE_OPEN);
         x.vol    =PositionGetDouble(POSITION_VOLUME);
         x.sl     =N(PositionGetDouble(POSITION_SL));
         x.tp     =N(PositionGetDouble(POSITION_TP));
         x.timeMsc=PositionGetInteger(POSITION_TIME_MSC);
         int n=ArraySize(p);
         ArrayResize(p,n+1);
         int j=n;
         while(j>0 && p[j-1].timeMsc>x.timeMsc) { p[j]=p[j-1]; j--; }
         p[j]=x;
      }
      return ArraySize(p);
   }

   // open positions of one ladder (copied out of the snapshot)
   int LadderPos(int slot,LMPos &all[],int na,LMPos &p[])
   {
      ArrayResize(p,0);
      for(int i=0;i<na;i++)
      {
         if(!m_L[slot].Owns(all[i].ticket)) continue;
         int n=ArraySize(p); ArrayResize(p,n+1); p[n]=all[i];
      }
      return ArraySize(p);
   }

   double Worst(int side,LMPos &p[],int n)
   {
      double w=p[0].entry;
      for(int i=1;i<n;i++) w=(side==0 ? MathMax(w,p[i].entry) : MathMin(w,p[i].entry));
      return w;
   }
   double TotalVol(LMPos &p[],int n) { double v=0; for(int i=0;i<n;i++) v+=p[i].vol; return v; }

   // v3: volume-weighted average entry of the open tickets
   double Avg(LMPos &p[],int n)
   {
      double pv=0,v=0;
      for(int i=0;i<n;i++) { pv+=p[i].entry*p[i].vol; v+=p[i].vol; }
      return v>0 ? pv/v : 0;
   }
   // v3: pips in favour from the average entry (negative = against you)
   double PipsFromAvg(int side,double avg)
   {
      if(PipSize<=0 || avg<=0) return 0;
      return Dir(side)*(PriceNow(side)-avg)/PipSize;
   }
   // v3: $ result of the open tickets if they all close at price px
   double MoneyAt(LMPos &p[],int n,double px)
   {
      double r=0;
      for(int j=0;j<n;j++)
      {
         double pr=0;
         if(OrderCalcProfit(p[j].side==0?ORDER_TYPE_BUY:ORDER_TYPE_SELL,_Symbol,p[j].vol,p[j].entry,px,pr)) r+=pr;
      }
      return r;
   }
   // v3: the average used for stages (live before stage 2, frozen after)
   double StageAvg(int slot,LMPos &p[],int n)
   {
      return (m_L[slot].stage>=2 && m_L[slot].anchor>0) ? m_L[slot].anchor : Avg(p,n);
   }

   //--- assign new tickets to the current ladder ----------------------
   void AssignNew(LMPos &all[],int na)
   {
      for(int i=0;i<na;i++)
      {
         if(OwnerSlot(all[i].ticket)>=0) continue;

         // no ladder to receive it -> start one (first ladder, or all previous closed)
         if(m_cur<0)
         {
            int newest=NewestActive(-1);
            if(newest>=0) m_cur=newest;                 // current closed earlier -> newest open ladder
            else
            {
               int slot=FreeSlot();
               if(slot<0) continue;
               m_L[slot].Reset();
               m_L[slot].id=++m_counter;
               m_cur=slot; m_page=slot;
               SaveMeta();
            }
         }
         CLadder *L=GetPointer(m_L[m_cur]);

         int reqSide=L.side;
         if(reqSide<0)
            for(int q=0;q<LM_MAX;q++) if(m_L[q].id>0 && m_L[q].side>=0) { reqSide=m_L[q].side; break; }
         if(reqSide>=0 && all[i].side!=reqSide)
         {
            if(!IsReported(all[i].ticket))
            {
               int n=ArraySize(m_unmanaged); ArrayResize(m_unmanaged,n+1); m_unmanaged[n]=all[i].ticket;
               Print("[LM] ",SideName(all[i].side)," #",all[i].ticket," is opposite to your open ladder(s) (",SideName(reqSide),
                     ") - NOT managed. Manage it yourself.");
            }
            continue;
         }

         bool first=(ArraySize(L.all)==0);
         if(L.side<0) L.side=all[i].side;
         L.AddAll(all[i].ticket);
         L.jLotsTotal+=all[i].vol;
         if(first)
         {
            L.jBalBefore=AccountInfoDouble(ACCOUNT_BALANCE);
            L.jNo=Rank(m_cur);
         }
         GlobalVariableSet(GT(all[i].ticket),L.id);

         LMPos p[];
         int n=LadderPos(m_cur,all,na,p);
         double avg=Avg(p,n);
         int dir=Dir(L.side);
         if(first)
         {
            L.start=(datetime)(all[i].timeMsc/1000);
            Print("[LM] ",Tag(m_cur)," STARTED | #",all[i].ticket," ",Lots(all[i].vol)," @ ",Px(all[i].entry),
                  " | stage 2 at ",Px(avg+dir*S2TrigPips*PipSize));
         }
         else if(L.stage==0)
            Print("[LM] ",Tag(m_cur)," TRADE ADDED #",all[i].ticket," ",Lots(all[i].vol)," @ ",Px(all[i].entry),
                  " | ",n," ticket(s) ",Lots(TotalVol(p,n))," lot | average ",Px(avg)," | stage 2 at ",Px(avg+dir*S2TrigPips*PipSize));
         else
            Print("[LM] ",Tag(m_cur)," TRADE ADDED after stage 2 #",all[i].ticket," ",Lots(all[i].vol)," @ ",Px(all[i].entry),
                  " | ",n," ticket(s) ",Lots(TotalVol(p,n))," lot | it takes the ladder SL ",Px(L.hasSL?L.mSL:0));
         SaveLadder(m_cur);
      }
   }

   //--- lot cap per ladder ------------------------------------------
   void EnforceCap(int slot,LMPos &p[],int &n)
   {
      double cap=LotCap();
      double run=0;
      bool closed=false;
      for(int i=0;i<n;i++)
      {
         if(run+p[i].vol > cap+1e-9)
         {
            if(m_trade.PositionClose(p[i].ticket) && m_trade.ResultRetcode()==TRADE_RETCODE_DONE)
            {
               Print("[LM] ",Tag(slot)," CAP ",Lots(cap)," lot | trade #",p[i].ticket," ",Lots(p[i].vol),
                     " lot CLOSED - ladder would exceed the cap");
               closed=true;
            }
            continue;
         }
         run+=p[i].vol;
      }
      if(closed)
      {
         LMPos all[]; int na=Snapshot(all);
         n=LadderPos(slot,all,na,p);
      }
   }

   void EnforcePendingCap()
   {
      double cap=LotCap();
      double run=0;
      if(m_cur>=0)
      {
         LMPos all[]; int na=Snapshot(all);
         LMPos p[];   int n=LadderPos(m_cur,all,na,p);
         run=TotalVol(p,n);
      }
      ulong ok[]; double ov[]; long ot[];
      ArrayResize(ok,0); ArrayResize(ov,0); ArrayResize(ot,0);
      for(int i=0;i<OrdersTotal();i++)
      {
         ulong k=OrderGetTicket(i);
         if(k==0) continue;
         if(OrderGetString(ORDER_SYMBOL)!=_Symbol) continue;
         if(!MagicOK(OrderGetInteger(ORDER_MAGIC))) continue;
         ENUM_ORDER_TYPE t=(ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
         if(t==ORDER_TYPE_BUY || t==ORDER_TYPE_SELL) continue;
         long st=OrderGetInteger(ORDER_TIME_SETUP_MSC);
         int n=ArraySize(ok);
         ArrayResize(ok,n+1); ArrayResize(ov,n+1); ArrayResize(ot,n+1);
         int j=n;
         while(j>0 && ot[j-1]>st) { ok[j]=ok[j-1]; ov[j]=ov[j-1]; ot[j]=ot[j-1]; j--; }
         ok[j]=k; ov[j]=OrderGetDouble(ORDER_VOLUME_CURRENT); ot[j]=st;
      }
      for(int i=0;i<ArraySize(ok);i++)
      {
         if(run+ov[i] > cap+1e-9)
         {
            double px=0;
            if(OrderSelect(ok[i])) px=OrderGetDouble(ORDER_PRICE_OPEN);
            if(m_trade.OrderDelete(ok[i]) && m_trade.ResultRetcode()==TRADE_RETCODE_DONE)
               Print("[LM] CAP ",Lots(cap)," lot per ladder | pending #",ok[i]," ",Lots(ov[i])," @ ",Px(px),
                     " DELETED - current ladder + pending would exceed the cap");
            continue;
         }
         run+=ov[i];
      }
   }

   //--- per-ladder SL/TP sync (your edits) ---------------------------
   void Sync(int slot,LMPos &p[],int n)
   {
      CLadder *L=GetPointer(m_L[slot]);

      // forget closed
      for(int i=ArraySize(L.tk)-1;i>=0;i--)
      {
         bool alive=false;
         for(int j=0;j<n;j++) if(p[j].ticket==L.tk[i]) { alive=true; break; }
         if(!alive) L.RemoveKnown(i);
      }

      // after a restart: take the SLs as they are now
      if(L.restored)
      {
         L.restored=false;
         bool allSame=true;
         for(int j=1;j<n;j++) if(!Same(p[j].sl,p[0].sl) || !Same(p[j].tp,p[0].tp)) { allSame=false; break; }
         if(n>0 && allSame)
         {
            if(p[0].sl>0) { L.mSL=p[0].sl; L.hasSL=true; }
            L.mTP=p[0].tp; L.hasTP=(p[0].tp>0 || L.hasTP);
         }
         for(int j=0;j<n;j++) if(L.Find(p[j].ticket)<0) L.AddKnown(p[j].ticket,p[j].sl,p[j].tp);
         Print("[LM] ",Tag(slot)," RESUMED after restart | ",n," ticket(s) | SL ",Px(L.hasSL?L.mSL:0),
               " | ",(L.stage==0?"waiting for stage 2":(L.stage==2?"stage 2 done":"stage 3 done - runner is yours")));
         SaveLadder(slot);
      }

      // edits on known tickets -> new master (your edit wins)
      ulong src=0;
      bool   slEdit=false;
      double slBefore=0;
      for(int j=0;j<n;j++)
      {
         int k=L.Find(p[j].ticket);
         if(k<0) continue;
         if(SyncSL && p[j].sl>0 && !Same(p[j].sl,L.ksl[k]) && !(L.hasSL && Same(p[j].sl,L.mSL)))
         {
            if(!slEdit) { slEdit=true; slBefore=(L.hasSL ? L.mSL : 0); }
            L.mSL=p[j].sl; L.hasSL=true; src=p[j].ticket;
         }
         if(SyncTP && !Same(p[j].tp,L.ktp[k]) && !(L.hasTP && Same(p[j].tp,L.mTP)))
         { L.mTP=p[j].tp; L.hasTP=true; src=p[j].ticket; }
         L.ksl[k]=p[j].sl; L.ktp[k]=p[j].tp;
      }
      if(slEdit)                     // journal: your SL edits
      {
         L.jSlEdits++;
         if(slBefore>0 && Better(L.side,slBefore,L.mSL)) L.jSlWidened=true;
      }
      if(src>0 && L.pending>0)
      {
         Print("[LM] ",Tag(slot)," your edit wins - waiting auto SL ",Px(L.pending)," cancelled");
         L.pending=0; L.logWait=-1;
      }

      // new tickets -> register; seed master only if none
      bool isNew[];
      ArrayResize(isNew,n);
      for(int j=0;j<n;j++)
      {
         isNew[j]=false;
         if(L.Find(p[j].ticket)>=0) continue;
         isNew[j]=true;
         L.AddKnown(p[j].ticket,p[j].sl,p[j].tp);
         if(SyncSL && !L.hasSL && p[j].sl>0) { L.mSL=p[j].sl; L.hasSL=true; }
         if(SyncTP && !L.hasTP && p[j].tp>0) { L.mTP=p[j].tp; L.hasTP=true; }
      }

      // push master
      datetime now=TimeCurrent();
      int copied=0, waitN=0, rejN=0;
      string what="", why="";
      if(src>0) L.syncLogWait=false;
      bool cooling=(L.fail>0 && (now-L.fail)<RetryCooldownSec && src==0);
      for(int j=0;j<n;j++)
      {
         double wantSL=(SyncSL && L.hasSL) ? L.mSL : p[j].sl;
         double wantTP=(SyncTP && L.hasTP) ? L.mTP : p[j].tp;
         if(Same(wantSL,p[j].sl) && Same(wantTP,p[j].tp)) continue;
         if(cooling) continue;
         int k=L.Find(p[j].ticket);
         if(!SLValidNow(L.side,wantSL) || !TPValidNow(L.side,wantTP))
         { waitN++; what="SL "+Px(wantSL)+" TP "+Px(wantTP); continue; }
         if(m_trade.PositionModify(p[j].ticket,wantSL,wantTP) && m_trade.ResultRetcode()==TRADE_RETCODE_DONE)
         {
            L.ksl[k]=wantSL; L.ktp[k]=wantTP; p[j].sl=wantSL; p[j].tp=wantTP;
            if(isNew[j]) Print("[LM] ",Tag(slot)," new trade #",p[j].ticket," got ladder SL ",Px(wantSL)," TP ",Px(wantTP));
            else copied++;
         }
         else { rejN++; what="SL "+Px(wantSL)+" TP "+Px(wantTP); why=m_trade.ResultRetcodeDescription(); }
      }
      if(waitN>0 || rejN>0) L.fail=now;
      if(copied>0)
      {
         if(src>0) Print("[LM] ",Tag(slot)," your edit on #",src," -> SL ",Px(L.hasSL?L.mSL:0)," TP ",Px(L.hasTP?L.mTP:0),
                         " copied to ",copied," ticket(s)");
         else      Print("[LM] ",Tag(slot)," ladder SL ",Px(L.hasSL?L.mSL:0)," TP ",Px(L.hasTP?L.mTP:0),
                         " applied to ",copied," ticket(s)");
         L.syncLogWait=false;
      }
      if((waitN>0 || rejN>0) && !L.syncLogWait)
      {
         L.syncLogWait=true;
         if(waitN>0) Print("[LM] ",Tag(slot)," ",waitN," ticket(s) cannot take ",what," yet (too close to price). Waiting.");
         if(rejN>0)  Print("[LM] ",Tag(slot)," broker rejected ",what," on ",rejN," ticket(s) (",why,"). Retrying quietly.");
      }
      if(src>0) SaveLadder(slot);
   }

   //--- set the ladder SL on every ticket ----------------------------
   int ModifyAll(int slot,LMPos &p[],int n,double sl)
   {
      CLadder *L=GetPointer(m_L[slot]);
      int ok=0;
      for(int j=0;j<n;j++)
      {
         double tp=(SyncTP && L.hasTP) ? L.mTP : p[j].tp;
         if(Same(p[j].sl,sl)) { ok++; continue; }
         if(m_trade.PositionModify(p[j].ticket,sl,tp) && m_trade.ResultRetcode()==TRADE_RETCODE_DONE)
         {
            ok++;
            p[j].sl=sl;
            int k=L.Find(p[j].ticket);
            if(k>=0) { L.ksl[k]=sl; L.ktp[k]=tp; }
         }
      }
      if(ok>0) { L.mSL=sl; L.hasSL=true; }
      return ok;
   }

   // try to move the ladder SL to L.pending; step back by spread if refused
   void TryPending(int slot,LMPos &p[],int n,string label)
   {
      CLadder *L=GetPointer(m_L[slot]);
      if(L.pending<=0 || n==0) return;
      datetime now=TimeCurrent();
      if(label=="" && L.fail>0 && (now-L.fail)<RetryCooldownSec) return;

      double cur=(L.hasSL ? L.mSL : 0);
      if(!Better(L.side,L.pending,cur))
      {
         if(label!="") Print("[LM] ",Tag(slot)," ",label," | auto SL ",Px(L.pending),
                             " not applied - your SL ",Px(cur)," is already better");
         L.pending=0; L.logWait=-1;
         SaveLadder(slot);
         return;
      }

      double spread=SymbolInfoDouble(_Symbol,SYMBOL_ASK)-SymbolInfoDouble(_Symbol,SYMBOL_BID);
      if(spread<=0) spread=_Point*10;
      int dir=Dir(L.side);
      for(int k=0;k<=5;k++)
      {
         double c=N(L.pending-dir*k*spread);
         if(!Better(L.side,c,cur)) break;               // stepping back would not improve anything
         if(!SLValidNow(L.side,c)) continue;
         double before=cur;
         if(ModifyAll(slot,p,n,c)==n)
         {
            if(k==0)
            {
               Print("[LM] ",Tag(slot)," ",(label!=""?label:"AUTO SL")," | SL ",Px(before)," -> ",Px(c),
                     (L.stage==2 ? " | stage 3 at "+Px(L.next) : (L.stage==3 ? " | runner is yours" : "")));
               L.pending=0; L.logWait=-1;
            }
            else
               Print("[LM] ",Tag(slot)," ",(label!=""?label:"AUTO SL")," | SL ",Px(before)," -> ",Px(c),
                     " (target ",Px(L.pending)," too close to price - will tighten when allowed)");
            L.fail=0;
            SaveLadder(slot);
            return;
         }
         L.fail=now;
         if(!Same(L.jRefLast,L.pending)) { L.jRefLast=L.pending; L.jAutoRef++; }   // journal: once per auto SL value
         SaveLadder(slot);
         return;                                        // partial failure: retry after cooldown
      }
      L.fail=now;
      if(!Same(L.logWait,L.pending))
      {
         L.logWait=L.pending;
         Print("[LM] ",Tag(slot)," ",(label!=""?label+" | ":""),"auto SL ",Px(L.pending),
               " not allowed yet (too close to price). Waiting.");
      }
      SaveLadder(slot);
   }

   //--- one ladder, one pass -----------------------------------------
   void ProcessLadder(int slot,LMPos &all[],int na)
   {
      CLadder *L=GetPointer(m_L[slot]);
      LMPos p[];
      int n=LadderPos(slot,all,na,p);

      if(n==0)
      {
         if(ArraySize(L.all)>0)        // it had trades -> closed
         {
            int bySL,byTP,byEA,byYou,byOther;
            double net=LadderNet(slot,bySL,byTP,byEA,byYou,byOther);
            string who="SL "+(string)bySL+" | TP "+(string)byTP+" | manager "+(string)byEA+" | you "+(string)byYou;
            if(byOther>0) who+=" | broker/other "+(string)byOther;
            Print("[LM] ",Tag(slot)," CLOSED | net ",Money(net)," | ",
                  (L.stage==0?"no stage":(L.stage==2?"stage 2":"stage 3")),
                  " | closed by: ",who);
            if(Journal) JournalAdd(slot,net,bySL,byTP,byEA,byYou,byOther);
            DeleteLadderSaved(slot);
            bool wasCur=(slot==m_cur);
            int  closedId=L.id;
            // remember ranks before, to report the shift
            int before[LM_MAX];
            for(int q=0;q<LM_MAX;q++) before[q]=(m_L[q].id>0 ? Rank(q) : 0);
            L.Reset();
            for(int q=0;q<LM_MAX;q++)
               if(m_L[q].id>closedId && Rank(q)!=before[q])
                  Print("[LM] L",before[q]," ",SideName(m_L[q].side)," is now ",Tag(q)," (opened ",
                        TimeToString(m_L[q].start,TIME_MINUTES),")");
            if(wasCur) m_cur=NewestActive(-1);
            if(m_page==slot) m_page=(m_cur>=0 ? m_cur : NewestActive(-1));
            SaveMeta();
         }
         return;
      }

      EnforceCap(slot,p,n);
      if(n==0) return;

      Sync(slot,p,n);

      int    dir  =Dir(L.side);
      double price=PriceNow(L.side);

      // STAGE 2 (average entry is frozen here)
      if(L.stage==0)
      {
         double avg=Avg(p,n);
         if(avg>0 && dir*(price-avg) >= S2TrigPips*PipSize-Eps())
         {
            L.anchor =avg;
            L.target =N(avg+dir*S2LockPips*PipSize);
            L.next   =N(avg+dir*S3TrigPips*PipSize);
            L.steps  =0;
            L.stage  =2;
            L.pending=L.target;
            L.jS2Time=TimeCurrent();
            SaveLadder(slot);
            TryPending(slot,p,n,StringFormat("STAGE 2 | price %s = average %s +%.0f pips | locks %s",
                       Px(price),Px(avg),S2TrigPips,Money(MoneyAt(p,n,L.target))));
         }
      }

      // STAGE 3 (last automatic move - after this the runner is yours)
      if(L.stage==2 && L.anchor>0) L.next=N(L.anchor+dir*S3TrigPips*PipSize);   // follows a panel change
      if(L.stage==2 && L.next>0 && dir*(price-L.next) >= -Eps())
      {
         L.target =N(L.anchor+dir*S3LockPips*PipSize);
         L.stage  =3;
         L.pending=L.target;
         SaveLadder(slot);
         TryPending(slot,p,n,StringFormat("STAGE 3 | price %s = average %s +%.0f pips | locks %s",
                    Px(price),Px(L.anchor),S3TrigPips,Money(MoneyAt(p,n,L.target))));
      }

      // retry a waiting auto SL
      if(L.pending>0) TryPending(slot,p,n,"");

      Track(slot,p,n);
   }

   //--- journal: measure the ladder every pass (no trading here) -------
   void Track(int slot,LMPos &p[],int n)
   {
      if(n==0) return;
      CLadder *L=GetPointer(m_L[slot]);
      bool ch=false;

      double vol=TotalVol(p,n);
      if(vol>L.jLotsMax+1e-9) { L.jLotsMax=vol; ch=true; }

      double w=Worst(L.side,p,n);          // journal keeps measuring from the worst entry
      if(w>0 && !Same(w,L.jWorst)) { L.jWorst=w; ch=true; }
      double price=PriceNow(L.side);
      if(w>0 && price>0)
      {
         double mv=Dir(L.side)*(price-w);
         if(!L.jMoveSeen) { L.jMfe=mv; L.jMae=mv; L.jMoveSeen=true; ch=true; }
         if(mv>L.jMfe+1e-9) { L.jMfe=mv; ch=true; }
         if(mv<L.jMae-1e-9) { L.jMae=mv; ch=true; }
      }

      // IF SL HITS with the SLs the tickets have now (skip while a ticket has no SL)
      double r=0; bool lim=true;
      for(int j=0;j<n;j++)
      {
         if(p[j].sl<=0) { lim=false; break; }
         double pr=0;
         if(OrderCalcProfit(p[j].side==0?ORDER_TYPE_BUY:ORDER_TYPE_SELL,_Symbol,p[j].vol,p[j].entry,p[j].sl,pr)) r+=pr;
      }
      if(lim && (!L.jRiskSeen || r<L.jRiskMax-0.005)) { L.jRiskMax=r; L.jRiskSeen=true; ch=true; }

      // first ladder SL: IF SL HITS with that SL on every open ticket
      if(L.jFirstSL<=0 && L.hasSL && L.mSL>0)
      {
         double r1=0;
         for(int j=0;j<n;j++)
         {
            double pr=0;
            if(OrderCalcProfit(p[j].side==0?ORDER_TYPE_BUY:ORDER_TYPE_SELL,_Symbol,p[j].vol,p[j].entry,L.mSL,pr)) r1+=pr;
         }
         L.jFirstSL=L.mSL; L.jRisk1=r1; ch=true;
      }
      if(ch) SaveJournal(slot);
   }

   //--- journal: exit facts from the deal history ---------------------
   void LadderExit(int slot,datetime &closeT,double &lastPx,double &avgIn,double &worstIn)
   {
      closeT=0; lastPx=0; avgIn=0; worstIn=0;
      CLadder *L=GetPointer(m_L[slot]);
      datetime from=(L.start>0 ? L.start-60 : TimeCurrent()-86400*7);
      if(!HistorySelect(from,TimeCurrent()+60)) return;
      double pv=0, v=0;
      long lastMsc=-1;
      int total=HistoryDealsTotal();
      for(int i=0;i<total;i++)
      {
         ulong d=HistoryDealGetTicket(i);
         if(d==0) continue;
         if(!L.Owns((ulong)HistoryDealGetInteger(d,DEAL_POSITION_ID))) continue;
         ENUM_DEAL_ENTRY e=(ENUM_DEAL_ENTRY)HistoryDealGetInteger(d,DEAL_ENTRY);
         double px =HistoryDealGetDouble(d,DEAL_PRICE);
         double dv =HistoryDealGetDouble(d,DEAL_VOLUME);
         if(e==DEAL_ENTRY_IN)
         {
            pv+=px*dv; v+=dv;
            if(worstIn<=0 || (L.side==1 ? px<worstIn : px>worstIn)) worstIn=px;
         }
         else if(e==DEAL_ENTRY_OUT || e==DEAL_ENTRY_OUT_BY || e==DEAL_ENTRY_INOUT)
         {
            long msc=HistoryDealGetInteger(d,DEAL_TIME_MSC);
            if(msc>=lastMsc) { lastMsc=msc; lastPx=px; closeT=(datetime)HistoryDealGetInteger(d,DEAL_TIME); }
         }
      }
      if(v>0) avgIn=pv/v;
   }

   //--- journal: CSV helpers ------------------------------------------
   string JT(datetime t)       { return t>0 ? TimeToString(t,TIME_DATE|TIME_SECONDS) : ""; }
   string JP(double p)         { return p>0 ? DoubleToString(p,_Digits) : ""; }
   string J2(double v)         { return DoubleToString(v,2); }
   string YN(bool b)           { return b ? "yes" : "no"; }
   string JClean(string s)     { string c=s; StringReplace(c,","," "); StringReplace(c,"\"","'"); return c; }
   string JHeader()
   {
      return "ladder_uid,ea_version,account,server,account_type,symbol,ladder_no,side,open_time,close_time,"
             "duration_min,tickets,lots_total,lots_max_open,worst_entry,avg_entry,first_sl,final_sl,sl_edits,sl_widened,"
             "risk_at_first_sl,risk_max,balance_before,balance_after,lot_per_100,stage2,stage2_time,trail_steps,"
             "mfe_price,mae_price,exit_giveback,net_usd,net_R,closed_by_sl,closed_by_tp,closed_by_manager,closed_by_you,"
             "closed_by_other,auto_sl_refused,restarted";
   }

   //--- journal: build the row of a closing ladder and queue it --------
   void JournalAdd(int slot,double net,int bySL,int byTP,int byEA,int byYou,int byOther)
   {
      CLadder *L=GetPointer(m_L[slot]);
      datetime closeT=0; double lastPx=0,avgIn=0,worstIn=0;
      LadderExit(slot,closeT,lastPx,avgIn,worstIn);
      if(closeT<=0) closeT=TimeCurrent();

      int    dir=Dir(L.side);
      double w  =(L.jWorst>0 ? L.jWorst : worstIn);
      double mfe=L.jMfe, mae=L.jMae;
      bool   seen=L.jMoveSeen;
      string give="";
      if(lastPx>0 && w>0)
      {
         double fin=dir*(lastPx-w);         // final move at exit
         if(!seen) { mfe=fin; mae=fin; seen=true; }
         mfe=MathMax(mfe,fin); mae=MathMin(mae,fin);
         give=J2(mfe-fin);
      }

      string srv =JClean(AccountInfoString(ACCOUNT_SERVER));
      string sym =JClean(_Symbol);
      string lgn =(string)AccountInfoInteger(ACCOUNT_LOGIN);
      string acT =(AccountInfoInteger(ACCOUNT_TRADE_MODE)==ACCOUNT_TRADE_MODE_REAL ? "REAL" : "DEMO");
      string uidT=TimeToString(L.start,TIME_DATE|TIME_SECONDS);
      StringReplace(uidT,".",""); StringReplace(uidT,":",""); StringReplace(uidT," ","");   // 20260930143512
      string uid =srv+"-"+lgn+"-"+sym+"-"+(string)L.id+"-"+uidT;
      int    no  =(L.jNo>0 ? L.jNo : Rank(slot));
      string dur =(L.start>0 ? DoubleToString((double)(closeT-L.start)/60.0,1) : "");
      string lp100=(L.jBalBefore>0 ? DoubleToString(L.jLotsMax/(L.jBalBefore/100.0),3) : "");
      bool   hasR1=(L.jFirstSL>0 && MathAbs(L.jRisk1)>0.005);
      string netR =(hasR1 ? J2(net/MathAbs(L.jRisk1)) : "");

      string row=uid+","+LM_VERSION+","+lgn+","+srv+","+acT+","+sym+",L"+(string)no+","+SideName(L.side)+","+
                 JT(L.start)+","+JT(closeT)+","+dur+","+(string)ArraySize(L.all)+","+
                 Lots(L.jLotsTotal)+","+Lots(L.jLotsMax)+","+JP(w)+","+JP(avgIn)+","+
                 JP(L.jFirstSL)+","+JP(L.hasSL?L.mSL:0)+","+(string)L.jSlEdits+","+YN(L.jSlWidened)+","+
                 (L.jFirstSL>0 ? J2(L.jRisk1) : "")+","+(L.jRiskSeen ? J2(L.jRiskMax) : "")+","+
                 (L.jBalBefore>0 ? J2(L.jBalBefore) : "")+","+J2(AccountInfoDouble(ACCOUNT_BALANCE))+","+lp100+","+
                 YN(L.stage>=2)+","+JT(L.jS2Time)+","+(string)L.steps+","+
                 (seen ? J2(mfe) : "")+","+(seen ? J2(mae) : "")+","+give+","+J2(net)+","+netR+","+
                 (string)bySL+","+(string)byTP+","+(string)byEA+","+(string)byYou+","+(string)byOther+","+
                 (string)L.jAutoRef+","+YN(L.jRestarted);

      int q=ArraySize(m_jq);
      ArrayResize(m_jq,q+1); ArrayResize(m_jqTag,q+1);
      m_jq[q]=row; m_jqTag[q]=Tag(slot)+" "+Money(net);
      JournalFlush();
   }

   //--- journal: append queued rows; if locked, say so once and retry --
   bool JournalFlush()
   {
      if(ArraySize(m_jq)==0) return true;
      m_jTry=GetTickCount();
      int h=FileOpen(LM_JFILE,FILE_READ|FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_COMMON|FILE_SHARE_READ,',',CP_UTF8);
      if(h==INVALID_HANDLE)
      {
         if(!m_jWaitLog) { m_jWaitLog=true; Print("[LM] JOURNAL waiting - close ",LM_JFILE," in Excel"); }
         return false;
      }
      if(FileSize(h)==0) FileWriteString(h,JHeader()+"\r\n");
      FileSeek(h,0,SEEK_END);
      for(int i=0;i<ArraySize(m_jq);i++) FileWriteString(h,m_jq[i]+"\r\n");
      FileClose(h);
      for(int i=0;i<ArraySize(m_jqTag);i++) Print("[LM] JOURNAL ",m_jqTag[i]," saved");
      ArrayResize(m_jq,0); ArrayResize(m_jqTag,0);
      m_jWaitLog=false;
      return true;
   }

   //--- result of a closed ladder ------------------------------------
   double LadderNet(int slot,int &bySL,int &byTP,int &byEA,int &byYou,int &byOther)
   {
      bySL=0; byTP=0; byEA=0; byYou=0; byOther=0;
      double net=0;
      CLadder *L=GetPointer(m_L[slot]);
      datetime from=(L.start>0 ? L.start-60 : TimeCurrent()-86400*7);
      if(!HistorySelect(from,TimeCurrent()+60)) return 0;
      int total=HistoryDealsTotal();
      for(int i=0;i<total;i++)
      {
         ulong d=HistoryDealGetTicket(i);
         if(d==0) continue;
         ulong pos=(ulong)HistoryDealGetInteger(d,DEAL_POSITION_ID);
         if(!L.Owns(pos)) continue;
         ENUM_DEAL_ENTRY e=(ENUM_DEAL_ENTRY)HistoryDealGetInteger(d,DEAL_ENTRY);
         net+=HistoryDealGetDouble(d,DEAL_PROFIT)+HistoryDealGetDouble(d,DEAL_SWAP)+HistoryDealGetDouble(d,DEAL_COMMISSION);
         if(e==DEAL_ENTRY_OUT || e==DEAL_ENTRY_OUT_BY || e==DEAL_ENTRY_INOUT)
         {
            ENUM_DEAL_REASON r=(ENUM_DEAL_REASON)HistoryDealGetInteger(d,DEAL_REASON);
            if(r==DEAL_REASON_SL)                 bySL++;
            else if(r==DEAL_REASON_TP)            byTP++;
            else if(r==DEAL_REASON_EXPERT)        byEA++;
            else if(r==DEAL_REASON_CLIENT || r==DEAL_REASON_MOBILE || r==DEAL_REASON_WEB) byYou++;
            else                                  byOther++;
         }
      }
      return net;
   }

   //--- $ if SL hits for one ladder (false = a ticket has no SL) ------
   bool LadderRisk(int slot,LMPos &all[],int na,double &risk)
   {
      risk=0;
      LMPos p[]; int n=LadderPos(slot,all,na,p);
      bool limited=true;
      for(int j=0;j<n;j++)
      {
         if(p[j].sl<=0) { limited=false; continue; }
         double pr=0;
         if(OrderCalcProfit(p[j].side==0?ORDER_TYPE_BUY:ORDER_TYPE_SELL,_Symbol,p[j].vol,p[j].entry,p[j].sl,pr))
            risk+=pr;
      }
      return limited;
   }

public:
   //--- settings
   long   MagicFilter;       // 0 = your manual trades only
   double S2TrigPips;        // stage 2 trigger, pips from average
   double S2LockPips;        // stage 2 SL, pips from average
   double S3TrigPips;        // stage 3 trigger, pips from average (frozen at stage 2)
   double S3LockPips;        // stage 3 SL, pips from average
   double LotPer100;
   bool   SyncSL;
   bool   SyncTP;
   int    RetryCooldownSec;
   bool   Journal;           // write LM_journal.csv
   bool   MarkRestart;       // true = restored ladders get restarted = yes
   //--- v3 stage 1
   double PipSize;           // price per pip (Gold: 0.10)
   double BEMinPips;         // BE allowed only from +this many pips from average entry
   double BEBufferPips;      // BE SL = average entry + this many pips

   void Init()
   {
      m_trade.LogLevel(LOG_LEVEL_NO);
      m_jWaitLog=false; m_jTry=0;   // m_jq is kept: rows not written yet stay queued
      for(int i=0;i<LM_MAX;i++) m_L[i].Reset();
      m_counter=0; m_cur=-1; m_page=-1;
      ArrayResize(m_unmanaged,0);
      LoadAll();
   }

   void Run()
   {
      LMPos all[];
      int na=Snapshot(all);
      AssignNew(all,na);
      for(int i=0;i<LM_MAX;i++)
      {
         if(m_L[i].id<=0) continue;
         na=Snapshot(all);
         ProcessLadder(i,all,na);
      }
      EnforcePendingCap();
      if(ArraySize(m_jq)>0 && GetTickCount()-m_jTry>=1000) JournalFlush();   // retry a locked journal file
   }

   // EA removed: last try; if still locked, print the rows so nothing is lost
   void JournalDeinit(int reason)
   {
      if(ArraySize(m_jq)==0 || JournalFlush()) return;
      if(reason==REASON_CHARTCHANGE) return;          // EA stays loaded, rows stay queued
      for(int i=0;i<ArraySize(m_jq);i++)
         Print("[LM] JOURNAL NOT saved - ",m_jqTag[i]," - copy this row into ",LM_JFILE,": ",m_jq[i]);
      ArrayResize(m_jq,0); ArrayResize(m_jqTag,0);
   }

   double LotCap()
   {
      return NormLotDown(AccountInfoDouble(ACCOUNT_BALANCE)/100.0*LotPer100);
   }

   //--- v3 STAGE 1: MOVE TO BE button (ladder shown on the panel) ------
   bool MoveToBE(string &msg)
   {
      int slot=m_page;
      if(slot<0 || m_L[slot].id<=0) { msg="no ladder on the panel"; return false; }
      CLadder *L=GetPointer(m_L[slot]);
      LMPos all[]; int na=Snapshot(all);
      LMPos p[];   int n=LadderPos(slot,all,na,p);
      if(n==0) { msg=LN(slot)+" has no open trades"; return false; }

      int    dir =Dir(L.side);
      double avg =Avg(p,n);
      double pips=PipsFromAvg(L.side,avg);
      if(pips < BEMinPips-1e-6)
      {
         msg=StringFormat("%s TOO EARLY | price %+.1f pips from average %s | BE allowed from +%.0f pips (%s)",
                          Tag(slot),pips,Px(avg),BEMinPips,Px(avg+dir*BEMinPips*PipSize));
         return false;
      }
      double be =N(avg+dir*BEBufferPips*PipSize);
      double cur=(L.hasSL ? L.mSL : 0);
      // s6: from +BEMinPips the button always works. If the SL is better than BE it is pulled back to
      // BE on purpose (gives locked profit back for room to retrace); it never goes below BE.
      bool allAtBE=true;
      for(int j=0;j<n;j++) if(!Same(p[j].sl,be)) { allAtBE=false; break; }
      if(cur>0 && Same(cur,be) && allAtBE)
      {
         msg=Tag(slot)+" SL is already at average +"+DoubleToString(BEBufferPips,0)+" pip ("+Px(be)+") - nothing changed";
         return false;
      }
      bool pullBack=(cur>0 && Better(L.side,cur,be));
      if(!SLValidNow(L.side,be))
      {
         msg=Tag(slot)+" BE "+Px(be)+" is too close to price for the broker - press again in a moment";
         return false;
      }
      int ok=ModifyAll(slot,p,n,be);
      if(ok==0)
      {
         msg=Tag(slot)+" broker refused BE "+Px(be)+" ("+m_trade.ResultRetcodeDescription()+") - nothing changed";
         return false;
      }
      L.jSlEdits++;
      if(pullBack) { L.pending=0; L.logWait=-1; L.jBePulled=true; }   // no waiting auto SL re-tightens it
      SaveLadder(slot);
      if(ok<n)
      {
         L.fail=TimeCurrent();
         msg=StringFormat("%s BE %s set on %d of %d ticket(s) - sync will push it to the rest",Tag(slot),Px(be),ok,n);
         return true;
      }
      msg=StringFormat("%s %s | SL %s -> %s (average %s +%.0f pip) | price %+.1f pips",
                       Tag(slot),(pullBack?"BE PULL-BACK":"STAGE 1"),Px(cur),Px(be),Px(avg),BEBufferPips,pips);
      return true;
   }

   //--- NEW LADDER button --------------------------------------------
   bool NewLadder(string &msg)
   {
      if(m_cur>=0)
      {
         LMPos all[]; int na=Snapshot(all);
         LMPos p[];   int n=LadderPos(m_cur,all,na,p);
         if(n==0) { msg=LN(m_cur)+" has no trades yet - use it first"; return false; }
      }
      // s6: no stage 2 needed - every open ladder only has to be at BE (all tickets have an SL and
      // IF SL HITS >= 0). Max 3 ladders.
      string locked="";
      if(!NewLadderAllowed(msg,locked)) return false;
      int slot=FreeSlot();
      if(slot<0) { msg="no free ladder slot"; return false; }
      m_L[slot].Reset();
      m_L[slot].id=++m_counter;
      m_cur=slot; m_page=slot;
      SaveMeta();

      int pend=0;
      for(int i=0;i<OrdersTotal();i++)
      {
         ulong k=OrderGetTicket(i);
         if(k>0 && OrderGetString(ORDER_SYMBOL)==_Symbol && MagicOK(OrderGetInteger(ORDER_MAGIC))) pend++;
      }
      msg=LN(slot)+" opened"+(locked!=""?" | "+locked:"")+" | your next trades join "+LN(slot)+
          (pend>0 ? " | "+(string)pend+" pending order(s) will join "+LN(slot)+" when filled" : "");
      return true;
   }

   //--- s6: NEW LADDER gate (also exported for Gold Replay live) -------
   bool NewLadderAllowed(string &why,string &locked)
   {
      why=""; locked="";
      if(m_cur>=0)
      {
         LMPos all0[]; int na0=Snapshot(all0);
         LMPos p0[];   int n0=LadderPos(m_cur,all0,na0,p0);
         if(n0==0) { why=LN(m_cur)+" has no trades yet - use it first"; return false; }
      }
      if(ActiveCount()>=LM_MAX) { why="maximum "+(string)LM_MAX+" ladders are open"; return false; }
      LMPos all[]; int na=Snapshot(all);
      for(int i=0;i<LM_MAX;i++)
      {
         if(m_L[i].id<=0) continue;
         double r;
         bool lim=LadderRisk(i,all,na,r);
         if(!lim)        { why=LN(i)+" has a ticket with NO SL"; return false; }
         if(r<-0.005)    { why=LN(i)+" is not at BE yet ("+Money(r)+" if SL hits)"; return false; }
         locked+=(locked==""?"":", ")+LN(i)+" locked "+Money(r);
      }
      return true;
   }

   //--- s6: state for Gold Replay live (JSON, written to Common\Files by the EA) ----
   string JS(string s) { StringReplace(s,"\\","\\\\"); StringReplace(s,"\"","\\\""); return "\""+s+"\""; }
   string StateJson(long cmdSeq,bool cmdOk,string cmdMsg)
   {
      LMPos all[]; int na=Snapshot(all);
      string why,locked;
      bool canNew=NewLadderAllowed(why,locked);
      string js="{\"version\":"+JS(LM_VERSION)+",\"symbol\":"+JS(_Symbol)+
                ",\"time\":"+(string)(long)TimeCurrent()+",\"lotCap\":"+DoubleToString(LotCap(),2)+
                ",\"canNewLadder\":"+(canNew?"true":"false")+",\"newLadderWhy\":"+JS(why)+
                ",\"cmd\":{\"seq\":"+(string)cmdSeq+",\"ok\":"+(cmdOk?"true":"false")+",\"msg\":"+JS(cmdMsg)+"}"+
                ",\"settings\":{\"beMin\":"+DoubleToString(BEMinPips,2)+",\"beBuf\":"+DoubleToString(BEBufferPips,2)+
                ",\"s2t\":"+DoubleToString(S2TrigPips,2)+",\"s2l\":"+DoubleToString(S2LockPips,2)+
                ",\"s3t\":"+DoubleToString(S3TrigPips,2)+",\"s3l\":"+DoubleToString(S3LockPips,2)+
                ",\"pip\":"+DoubleToString(PipSize,5)+"}"+
                ",\"ladders\":[";
      bool first=true;
      for(int i=0;i<LM_MAX;i++)
      {
         if(m_L[i].id<=0) continue;
         CLadder *L=GetPointer(m_L[i]);
         LMPos p[]; int n=LadderPos(i,all,na,p);
         string tk="";
         for(int j=0;j<n;j++) tk+=(j>0?",":"")+(string)p[j].ticket;
         js+=(first?"":",")+"{\"id\":"+(string)L.id+",\"rank\":"+(string)Rank(i)+
             ",\"side\":"+(string)L.side+",\"stage\":"+(string)L.stage+
             ",\"anchor\":"+DoubleToString(L.anchor,_Digits)+",\"next\":"+DoubleToString(L.next,_Digits)+
             ",\"pending\":"+DoubleToString(L.pending,_Digits)+
             ",\"sl\":"+DoubleToString(L.hasSL?L.mSL:0,_Digits)+",\"tp\":"+DoubleToString(L.hasTP?L.mTP:0,_Digits)+
             ",\"riskSeen\":"+(L.jRiskSeen?"true":"false")+",\"riskMax\":"+DoubleToString(L.jRiskMax,2)+
             ",\"firstSL\":"+DoubleToString(L.jFirstSL,_Digits)+",\"risk1\":"+DoubleToString(L.jRisk1,2)+
             ",\"bePulled\":"+(L.jBePulled?"true":"false")+
             ",\"start\":"+(string)(long)L.start+",\"current\":"+(i==m_cur?"true":"false")+
             ",\"tickets\":["+tk+"]}";
         first=false;
      }
      return js+"]}";
   }

   //--- panel data ----------------------------------------------------
   // s6: show the ladder with this id on the panel page (MOVE TO BE acts on the page's ladder)
   bool ShowLadder(int id)
   {
      int slot=SlotOfId(id);
      if(slot<0) return false;
      m_page=slot;
      return true;
   }
   int  LadderCount()  { return ActiveCount(); }
   void PageNext()
   {
      if(ActiveCount()==0) return;
      int start=(m_page<0?0:m_page);
      for(int k=1;k<=LM_MAX;k++) { int i=(start+k)%LM_MAX; if(m_L[i].id>0) { m_page=i; return; } }
   }
   void PagePrev()
   {
      if(ActiveCount()==0) return;
      int start=(m_page<0?0:m_page);
      for(int k=1;k<=LM_MAX;k++) { int i=(start-k+LM_MAX*2)%LM_MAX; if(m_L[i].id>0) { m_page=i; return; } }
   }

   // page title + 4 lines for the ladder on the current page
   void PageLines(string &title,string &l1,string &l2,string &l3,string &l4,string &l5,color &riskColor)
   {
      riskColor=clrSilver;
      l5=" ";
      if(m_page<0 || m_L[m_page].id<=0)
      {
         int s=NewestActive(-1);
         m_page=s;
      }
      if(m_page<0)
      {
         title="no ladder"; l1="Open a trade to start L1"; l2=" "; l3=" "; l4=" ";
         return;
      }
      int cnt=ActiveCount();
      CLadder *L=GetPointer(m_L[m_page]);
      title="LADDER "+LN(m_page)+" of "+(string)cnt;

      LMPos all[]; int na=Snapshot(all);
      LMPos p[];   int n=LadderPos(m_page,all,na,p);
      if(L.start>0) title+="   opened "+TimeToString(L.start,TIME_MINUTES);
      if(m_page==m_cur) title+="   <- new trades";
      if(n==0)
      {
         l1=SideName(L.side)+"  empty - your next trades join this ladder";
         l2=" "; l3=" "; l4=" ";
         return;
      }
      int dir=Dir(L.side);
      double w=Worst(L.side,p,n);
      l1=StringFormat("%s | %d ticket(s) %s lot | worst entry %s",SideName(L.side),n,Lots(TotalVol(p,n)),Px(w));

      // v3 stage status, measured from the average entry (frozen from stage 2)
      double avg =StageAvg(m_page,p,n);
      double pips=PipsFromAvg(L.side,avg);
      double be  =N(avg+dir*BEBufferPips*PipSize);
      double cur =(L.hasSL ? L.mSL : 0);
      string beTxt;
      if(cur>0 && !Better(L.side,be,cur)) beTxt="BE done";
      else if(pips>=BEMinPips-1e-6)       beTxt="BE allowed";
      else                                beTxt="BE from "+Px(avg+dir*BEMinPips*PipSize);
      l2="SL "+Px(cur)+"   TP "+Px(L.hasTP?L.mTP:0)+
         StringFormat("   | avg %s  %+.1f pips | %s",Px(avg),pips,beTxt);

      if(L.stage==0)
      {
         double s2=N(avg+dir*S2LockPips*PipSize);
         l3="stage 2 at "+Px(avg+dir*S2TrigPips*PipSize)+" -> SL "+Px(s2)+" locks "+Money(MoneyAt(p,n,s2));
      }
      else if(L.stage==2)
      {
         double s3=N(L.anchor+dir*S3LockPips*PipSize);
         l3="STAGE 2 done | stage 3 at "+Px(L.next)+" -> SL "+Px(s3)+" locks "+Money(MoneyAt(p,n,s3));
      }
      else                l3="STAGE 3 done | runner is yours - move the SL as you see fit";
      if(L.pending>0) l3+=" | waiting "+Px(L.pending);

      double r; bool lim=LadderRisk(m_page,all,na,r);
      if(!lim) { l4="IF SL HITS: NO SL - UNLIMITED LOSS"; riskColor=clrRed; }
      else
      {
         double bal=AccountInfoDouble(ACCOUNT_BALANCE);
         l4="IF SL HITS: "+Money(r);
         if(r<-0.005 && bal>0) l4+=StringFormat(" = %.1f%% of balance",-r/bal*100.0);
         else if(r>=0)         l4+=" (locked)";
         riskColor=(r>=0?clrLimeGreen:clrTomato);
      }

      // v3: IF CLOSED NOW in $ and R. R = worst IF SL HITS seen (the original SL,
      // larger if the SL was widened or tickets added) - it stays frozen after BE.
      double now=MoneyAt(p,n,PriceNow(L.side));
      l5="IF CLOSED NOW: "+Money(now);
      if(L.jRiskSeen && L.jRiskMax<-0.005)
      {
         double R=-L.jRiskMax;
         double rr=now/R;
         l5+=StringFormat(" = %.2fR   (1R = $%.2f)",rr,R);
         if(rr<1.0) l5+="   below 1R";
      }
      else l5+="   (R unknown - no SL set yet)";
   }

   // total over all ladders, plus pending orders (they join the current ladder)
   bool TotalRisk(double &openR,double &allR,int &unmanaged)
   {
      openR=0; allR=0; unmanaged=0;
      LMPos all[]; int na=Snapshot(all);
      bool limited=true;
      for(int i=0;i<na;i++)
      {
         int slot=OwnerSlot(all[i].ticket);
         if(slot<0) { unmanaged++; continue; }
         if(all[i].sl<=0) { limited=false; continue; }
         double pr=0;
         if(OrderCalcProfit(all[i].side==0?ORDER_TYPE_BUY:ORDER_TYPE_SELL,_Symbol,all[i].vol,all[i].entry,all[i].sl,pr))
            openR+=pr;
      }
      allR=openR;
      double curSL=(m_cur>=0 && m_L[m_cur].hasSL ? m_L[m_cur].mSL : 0);
      for(int i=0;i<OrdersTotal();i++)
      {
         ulong k=OrderGetTicket(i);
         if(k==0) continue;
         if(OrderGetString(ORDER_SYMBOL)!=_Symbol) continue;
         if(!MagicOK(OrderGetInteger(ORDER_MAGIC))) continue;
         ENUM_ORDER_TYPE t=(ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
         bool buy =(t==ORDER_TYPE_BUY_LIMIT || t==ORDER_TYPE_BUY_STOP || t==ORDER_TYPE_BUY_STOP_LIMIT);
         bool sell=(t==ORDER_TYPE_SELL_LIMIT || t==ORDER_TYPE_SELL_STOP || t==ORDER_TYPE_SELL_STOP_LIMIT);
         if(!buy && !sell) continue;
         double sl=(curSL>0 ? curSL : OrderGetDouble(ORDER_SL));
         if(sl<=0) { limited=false; continue; }
         double pr=0;
         if(OrderCalcProfit(buy?ORDER_TYPE_BUY:ORDER_TYPE_SELL,_Symbol,OrderGetDouble(ORDER_VOLUME_CURRENT),
                            OrderGetDouble(ORDER_PRICE_OPEN),sl,pr))
            allR+=pr;
      }
      return limited;
   }
};

#endif
