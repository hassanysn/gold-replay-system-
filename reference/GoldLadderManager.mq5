//+------------------------------------------------------------------+
//| GoldLadderManager.mq5  v3.0 (s6: BE pull-back, new ladder at BE, |
//|                        state/command files for Gold Replay live)  |
//| Manages the trades YOU open, grouped into ladders (max 3).       |
//| Needs LadderManager.mqh in the same folder.                      |
//| Manual edits always win; the EA only acts at stage 2 and 3.      |
//| Panel: drag by the title bar, A-/A+ size, pages < >, NEW LADDER, |
//|        MOVE TO BE (stage 1, for the ladder shown on the page).   |
//| s6: MOVE TO BE also pulls a better SL back to average +1 pip;    |
//|     NEW LADDER only needs every open ladder at BE (no stage 2);  |
//|     writes Common\Files\GLM_state_<symbol>.json for Gold Replay |
//|     live and runs its commands from GLM_cmd_<symbol>.txt.        |
//| Journal: one row per closed ladder in Common\Files\LM_journal.csv|
//+------------------------------------------------------------------+
#property version   "3.00"

#include "LadderManager.mqh"

input group "Trades managed"
input long   InpMagicFilter      = 0;     // 0 = your manual trades only

input group "Stage 1 - breakeven (v3)"
input double InpPipSize          = 0.10;  // Price per pip (Gold: 0.10)
input double InpBEMinPips        = 30;    // BE allowed only from +pips from AVERAGE entry
input double InpBEBufferPips     = 1;     // BE SL = average entry + this many pips

input group "Stages 2 & 3 - profit lock (v3, pips from AVERAGE entry)"
input double InpS2TrigPips       = 50;    // Stage 2: at average +pips...
input double InpS2LockPips       = 20;    // Stage 2: ...SL = average + this many pips
input double InpS3TrigPips       = 100;   // Stage 3: at average +pips...
input double InpS3LockPips       = 50;    // Stage 3: ...SL = average + this many pips (then runner is yours)

input group "Risk (not editable on the panel)"
input double InpLotPer100        = 0.10;  // Lot cap PER LADDER per $100 of balance

input group "Sync"
input bool   InpSyncSL           = true;  // Copy SL edits to the whole ladder
input bool   InpSyncTP           = true;  // Copy TP edits to the whole ladder (TP 0 = none)
input int    InpRetryCooldownSec = 5;     // Wait before retrying a refused change

input group "Journal"
input bool   InpJournal          = true;  // Write the trade journal

input group "Panel"
input bool   InpResetPanel       = false; // Move the panel back to the top-right corner

input group "Gold Replay live (s6)"
input bool   InpLiveBridge       = true;  // Share ladder state with Gold Replay live and accept its NEW LADDER / MOVE TO BE

CLadderManager g_lm;
uint           g_lastPanel=0;

//--- s6: Gold Replay live bridge (files in the terminals' Common\Files folder)
long   g_cmdSeq=0;
bool   g_cmdOk=false;
string g_cmdMsg="";
string StateFile() { return "GLM_state_"+_Symbol+".json"; }
string CmdFile()   { return "GLM_cmd_"+_Symbol+".txt"; }

// command line written by Gold Replay live: "seq|action|ladderId"  (action: newLadder, moveToBE)
void ReadLiveCommand()
{
   if(!InpLiveBridge || !FileIsExist(CmdFile(),FILE_COMMON)) return;
   int h=FileOpen(CmdFile(),FILE_READ|FILE_TXT|FILE_ANSI|FILE_COMMON|FILE_SHARE_READ);
   if(h==INVALID_HANDLE) return;
   string line=FileReadString(h);
   FileClose(h);
   FileDelete(CmdFile(),FILE_COMMON);
   string parts[];
   if(StringSplit(line,'|',parts)<2) return;
   long seq=StringToInteger(parts[0]);
   if(seq<=g_cmdSeq) return;
   string act=parts[1];
   int ladderId=(ArraySize(parts)>2 ? (int)StringToInteger(parts[2]) : 0);
   string msg="";
   bool ok=false;
   if(act=="newLadder")
   {
      ok=g_lm.NewLadder(msg);
      Print("[LM] NEW LADDER ",(ok?"":"refused - "),msg,"  (from Gold Replay live)");
   }
   else if(act=="moveToBE")
   {
      if(!g_lm.ShowLadder(ladderId)) msg="ladder not found";
      else ok=g_lm.MoveToBE(msg);
      Print("[LM] ",(ok?"":"MOVE TO BE refused - "),msg,"  (from Gold Replay live)");
   }
   else msg="unknown command "+act;
   g_cmdSeq=seq; g_cmdOk=ok; g_cmdMsg=msg;
}

uint g_lastState=0;
void WriteLiveState()
{
   if(!InpLiveBridge) return;
   g_lastState=GetTickCount();
   string tmp="GLM_state_"+_Symbol+".tmp";
   int h=FileOpen(tmp,FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(h==INVALID_HANDLE) return;
   FileWriteString(h,g_lm.StateJson(g_cmdSeq,g_cmdOk,g_cmdMsg));
   FileClose(h);
   FileMove(tmp,FILE_COMMON,StateFile(),FILE_COMMON|FILE_REWRITE);
}

//--- panel state (remembered across restarts)
int    g_x=-1, g_y=30;          // top-left corner, pixels
int    g_scIdx=2;               // size step
double SCALES[]={0.8,0.9,1.0,1.1,1.25,1.4};
bool   g_min=false;
bool   g_drag=false, g_prevLeft=false, g_scrollWas=true;
int    g_offx=0, g_offy=0;

string EDIT_KEYS[]  ={"s2t","s2l","s3t","s3l"};
string EDIT_NAMES[] ={"Stage 2 trigger  pips","Stage 2 lock  pips","Stage 3 trigger  pips","Stage 3 lock  pips"};

//+------------------------------------------------------------------+
//| settings (all pips from the average entry)                       |
//+------------------------------------------------------------------+
double GetSetting(string key)
{
   if(key=="s2t") return g_lm.S2TrigPips;
   if(key=="s2l") return g_lm.S2LockPips;
   if(key=="s3t") return g_lm.S3TrigPips;
   if(key=="s3l") return g_lm.S3LockPips;
   return 0;
}
// order must stay: BE buffer < S2 lock < S2 trigger,  S2 lock < S3 lock < S3 trigger,  S2 trigger < S3 trigger
string StageCheck(double s2t,double s2l,double s3t,double s3l)
{
   if(s2l<=InpBEBufferPips) return "stage 2 lock must be above the BE buffer";
   if(s2t<=s2l)             return "stage 2 trigger must be above stage 2 lock";
   if(s3l<=s2l)             return "stage 3 lock must be above stage 2 lock";
   if(s3t<=s3l)             return "stage 3 trigger must be above stage 3 lock";
   if(s3t<=s2t)             return "stage 3 trigger must be above stage 2 trigger";
   return "";
}
string SetSetting(string key,double v)
{
   double s2t=g_lm.S2TrigPips, s2l=g_lm.S2LockPips, s3t=g_lm.S3TrigPips, s3l=g_lm.S3LockPips;
   if(key=="s2t")      s2t=v;
   else if(key=="s2l") s2l=v;
   else if(key=="s3t") s3t=v;
   else if(key=="s3l") s3l=v;
   else return "unknown setting";
   if(v<=0 || v>1000) return "must be between 0 and 1000 pips";
   string why=StageCheck(s2t,s2l,s3t,s3l);
   if(why!="") return why;
   g_lm.S2TrigPips=s2t; g_lm.S2LockPips=s2l; g_lm.S3TrigPips=s3t; g_lm.S3LockPips=s3l;
   return "";
}
string Fmt(double v) { return DoubleToString(v,2); }

//+------------------------------------------------------------------+
//| sizes                                                            |
//+------------------------------------------------------------------+
double SC()        { return SCALES[g_scIdx]; }
int    S(int v)    { return (int)MathRound(v*SC()); }
int    FS(int v)   { return (int)MathMax(6,MathRound(v*SC())); }
int    PW()        { return S(470); }
int    RW()        { return S(18); }
int    TBW()       { return S(96); }        // title-bar buttons area

int Y_INFO()  { return RW()+S(4); }
int Y_TOTAL() { return 2*RW()+S(4); }
int Y_PAGE()  { return 3*RW()+S(14); }
int Y_L1()    { return 4*RW()+S(18); }
int Y_NEW()   { return 10*RW()-S(2); }
int Y_SET()   { return 12*RW()+S(10); }
int PH()      { return g_min ? RW()+S(10) : Y_SET()+(ArraySize(EDIT_KEYS)+1)*RW()+S(14); }

string GVP(string k) { return "LM."+_Symbol+".panel."+k; }
void SavePanel()
{
   GlobalVariableSet(GVP("x"),g_x);
   GlobalVariableSet(GVP("y"),g_y);
   GlobalVariableSet(GVP("s"),g_scIdx);
   GlobalVariableSet(GVP("m"),g_min?1:0);
}
void LoadPanel()
{
   if(!InpResetPanel && GlobalVariableCheck(GVP("x")))
   {
      g_x=(int)GlobalVariableGet(GVP("x"));
      g_y=(int)GlobalVariableGet(GVP("y"));
      g_scIdx=(int)GlobalVariableGet(GVP("s"));
      g_min=GlobalVariableGet(GVP("m"))>0.5;
   }
   if(g_scIdx<0 || g_scIdx>=ArraySize(SCALES)) g_scIdx=2;
   if(g_x<0)
   {
      int cw=(int)ChartGetInteger(0,CHART_WIDTH_IN_PIXELS);
      g_x=MathMax(5,cw-PW()-S(80));
      g_y=30;
   }
}
void Clamp()
{
   int cw=(int)ChartGetInteger(0,CHART_WIDTH_IN_PIXELS);
   int ch=(int)ChartGetInteger(0,CHART_HEIGHT_IN_PIXELS);
   if(cw>0) g_x=MathMax(5,MathMin(g_x,cw-PW()-10));
   if(ch>0) g_y=MathMax(5,MathMin(g_y,ch-RW()-10));
}

//+------------------------------------------------------------------+
//| objects (lx/ly = pixels inside the panel)                        |
//+------------------------------------------------------------------+
void Label(string name,int lx,int ly,string text,color c,int size=9,bool bold=false)
{
   if(ObjectFind(0,name)<0)
   {
      ObjectCreate(0,name,OBJ_LABEL,0,0,0);
      ObjectSetInteger(0,name,OBJPROP_CORNER,CORNER_LEFT_UPPER);
      ObjectSetInteger(0,name,OBJPROP_ANCHOR,ANCHOR_LEFT_UPPER);
      ObjectSetInteger(0,name,OBJPROP_SELECTABLE,false);
      ObjectSetInteger(0,name,OBJPROP_HIDDEN,true);
   }
   ObjectSetInteger(0,name,OBJPROP_XDISTANCE,g_x+lx);
   ObjectSetInteger(0,name,OBJPROP_YDISTANCE,g_y+ly);
   ObjectSetString (0,name,OBJPROP_TEXT,text);
   ObjectSetString (0,name,OBJPROP_FONT,bold?"Arial Bold":"Arial");
   ObjectSetInteger(0,name,OBJPROP_FONTSIZE,FS(size));
   ObjectSetInteger(0,name,OBJPROP_COLOR,c);
}

void Button(string name,int lx,int ly,int w,int h,string text,color bg)
{
   if(ObjectFind(0,name)<0)
   {
      ObjectCreate(0,name,OBJ_BUTTON,0,0,0);
      ObjectSetInteger(0,name,OBJPROP_CORNER,CORNER_LEFT_UPPER);
      ObjectSetInteger(0,name,OBJPROP_SELECTABLE,false);
      ObjectSetInteger(0,name,OBJPROP_HIDDEN,true);
      ObjectSetInteger(0,name,OBJPROP_STATE,false);
   }
   ObjectSetInteger(0,name,OBJPROP_XDISTANCE,g_x+lx);
   ObjectSetInteger(0,name,OBJPROP_YDISTANCE,g_y+ly);
   ObjectSetInteger(0,name,OBJPROP_XSIZE,w);
   ObjectSetInteger(0,name,OBJPROP_YSIZE,h);
   ObjectSetInteger(0,name,OBJPROP_FONTSIZE,FS(9));
   ObjectSetString (0,name,OBJPROP_TEXT,text);
   ObjectSetInteger(0,name,OBJPROP_BGCOLOR,bg);
   ObjectSetInteger(0,name,OBJPROP_COLOR,clrWhite);
}

void EditBox(string name,int lx,int ly,string text)
{
   bool fresh=(ObjectFind(0,name)<0);
   if(fresh)
   {
      ObjectCreate(0,name,OBJ_EDIT,0,0,0);
      ObjectSetInteger(0,name,OBJPROP_CORNER,CORNER_LEFT_UPPER);
      ObjectSetInteger(0,name,OBJPROP_ALIGN,ALIGN_RIGHT);
      ObjectSetInteger(0,name,OBJPROP_BGCOLOR,C'40,40,40');
      ObjectSetInteger(0,name,OBJPROP_COLOR,clrWhite);
      ObjectSetInteger(0,name,OBJPROP_BORDER_COLOR,clrGray);
      ObjectSetInteger(0,name,OBJPROP_HIDDEN,true);
      ObjectSetString (0,name,OBJPROP_TEXT,text);
   }
   ObjectSetInteger(0,name,OBJPROP_XDISTANCE,g_x+lx);
   ObjectSetInteger(0,name,OBJPROP_YDISTANCE,g_y+ly);
   ObjectSetInteger(0,name,OBJPROP_XSIZE,S(60));
   ObjectSetInteger(0,name,OBJPROP_YSIZE,S(16));
   ObjectSetInteger(0,name,OBJPROP_FONTSIZE,FS(9));
}

void Background()
{
   string bg="GLM_BG";
   if(ObjectFind(0,bg)<0)
   {
      ObjectCreate(0,bg,OBJ_RECTANGLE_LABEL,0,0,0);
      ObjectSetInteger(0,bg,OBJPROP_CORNER,CORNER_LEFT_UPPER);
      ObjectSetInteger(0,bg,OBJPROP_BGCOLOR,C'20,20,20');
      ObjectSetInteger(0,bg,OBJPROP_BORDER_TYPE,BORDER_FLAT);
      ObjectSetInteger(0,bg,OBJPROP_COLOR,clrDimGray);
      ObjectSetInteger(0,bg,OBJPROP_SELECTABLE,false);
      ObjectSetInteger(0,bg,OBJPROP_HIDDEN,true);
   }
   ObjectSetInteger(0,bg,OBJPROP_XDISTANCE,g_x-5);
   ObjectSetInteger(0,bg,OBJPROP_YDISTANCE,g_y-5);
   ObjectSetInteger(0,bg,OBJPROP_XSIZE,PW()+10);
   ObjectSetInteger(0,bg,OBJPROP_YSIZE,PH());
}

// place every object at the current position/size (no delete = no flicker while dragging)
void Layout()
{
   Background();
   Label("GLM_T",S(8),0,"GOLD LADDER MANAGER v"+LM_VERSION+"  |  "+_Symbol+"   (drag here)",clrGold,10,true);
   int bw=S(26), bh=S(18);
   Button("GLM_SM", PW()-S(92),-S(2),bw,bh,"A-",clrDimGray);
   Button("GLM_SP", PW()-S(62),-S(2),bw,bh,"A+",clrDimGray);
   Button("GLM_MIN",PW()-S(30),-S(2),S(24),bh,g_min?"+":"-",clrDimGray);
   if(g_min) { ChartRedraw(); return; }

   Button("GLM_PREV",S(8),Y_PAGE()-S(2),bw,bh,"<",clrDimGray);
   Button("GLM_NEXT",PW()-S(34),Y_PAGE()-S(2),bw,bh,">",clrDimGray);
   Button("GLM_NEW",S(8),Y_NEW(),S(140),S(22),"NEW LADDER",clrSeaGreen);
   Button("GLM_BE",S(158),Y_NEW(),S(140),S(22),"MOVE TO BE",clrSteelBlue);
   Label("GLM_SETH",S(8),Y_SET()-RW()+S(2),"SETTINGS (type a value + Enter)",clrSilver,8,true);
   for(int i=0;i<ArraySize(EDIT_KEYS);i++)
   {
      Label("GLM_C_"+EDIT_KEYS[i],S(8),Y_SET()+i*RW(),EDIT_NAMES[i],clrSilver,9);
      EditBox("GLM_E_"+EDIT_KEYS[i],S(160),Y_SET()+i*RW()-S(1),Fmt(GetSetting(EDIT_KEYS[i])));
   }
   RefreshPanel();
}

void BuildPanel()
{
   ObjectsDeleteAll(0,"GLM_");
   Clamp();
   Layout();
}

void RefreshPanel()
{
   if(g_min) return;
   double bal=AccountInfoDouble(ACCOUNT_BALANCE);
   Label("GLM_INFO",S(8),Y_INFO(),
         StringFormat("Balance $%.2f  |  cap %.2f lot per ladder  |  ladders %d of %d",bal,g_lm.LotCap(),g_lm.LadderCount(),LM_MAX),
         clrSilver,9);

   double openR,allR; int unmanaged;
   bool lim=g_lm.TotalRisk(openR,allR,unmanaged);
   string tot; color tc;
   if(!lim) { tot="TOTAL IF SL HITS:  NO SL - UNLIMITED LOSS"; tc=clrRed; }
   else
   {
      double pct=(bal>0?allR/bal*100.0:0);
      tot=StringFormat("TOTAL IF SL HITS:  %s%.2f   (with pending %s%.2f  %s%.1f%%)",
                       openR>=0?"+$":"-$",MathAbs(openR),allR>=0?"+$":"-$",MathAbs(allR),pct>=0?"+":"",pct);
      tc=(allR>=0?clrLimeGreen:clrTomato);
   }
   if(unmanaged>0) tot+="  | "+(string)unmanaged+" unmanaged";
   Label("GLM_TOT",S(8),Y_TOTAL(),tot,tc,9,true);

   string title,l1,l2,l3,l4,l5; color rc;
   g_lm.PageLines(title,l1,l2,l3,l4,l5,rc);
   Label("GLM_PT",S(42),Y_PAGE(),title,clrWhite,9,true);
   Label("GLM_L1",S(8),Y_L1(),l1,clrDeepSkyBlue,9);
   Label("GLM_L2",S(8),Y_L1()+RW(),l2,clrSilver,9);
   Label("GLM_L3",S(8),Y_L1()+2*RW(),l3,clrOrange,9);
   Label("GLM_L4",S(8),Y_L1()+3*RW(),l4,rc,9,true);
   Label("GLM_L5",S(8),Y_L1()+4*RW(),l5,clrWhite,9,true);
   ChartRedraw();
}

bool InTitleBar(int mx,int my)
{
   return mx>=g_x-5 && mx<=g_x+PW()-TBW() && my>=g_y-5 && my<=g_y+RW()+S(2);
}

//+------------------------------------------------------------------+
int OnInit()
{
   LoadPanel();
   ChartSetInteger(0,CHART_EVENT_MOUSE_MOVE,true);

   if(InpPipSize<=0 || InpBEMinPips<0 || InpBEBufferPips<0 || InpBEBufferPips>=InpBEMinPips)
   {
      Print("[LM] Stage 1 inputs invalid: pip size must be > 0 and BE buffer must be below the BE minimum distance");
      return INIT_PARAMETERS_INCORRECT;
   }
   string why=StageCheck(InpS2TrigPips,InpS2LockPips,InpS3TrigPips,InpS3LockPips);
   if(why!="")
   {
      Print("[LM] Stage 2/3 inputs invalid: ",why);
      return INIT_PARAMETERS_INCORRECT;
   }

   // cap may only change while no trade is open
   double lotPer100=InpLotPer100;
   string gvCap="LM."+_Symbol+".lotper100";
   bool open=false;
   for(int i=0;i<PositionsTotal();i++)
   {
      ulong k=PositionGetTicket(i);
      if(k==0 || !PositionSelectByTicket(k)) continue;
      if(PositionGetString(POSITION_SYMBOL)==_Symbol &&
         (InpMagicFilter<0 || PositionGetInteger(POSITION_MAGIC)==InpMagicFilter)) { open=true; break; }
   }
   if(open && GlobalVariableCheck(gvCap) && MathAbs(GlobalVariableGet(gvCap)-InpLotPer100)>1e-9)
   {
      lotPer100=GlobalVariableGet(gvCap);
      Print("[LM] Lot cap change IGNORED while trades are open - still ",DoubleToString(lotPer100,2),
            " per $100 per ladder. Change it again when all ladders are closed.");
   }
   else GlobalVariableSet(gvCap,lotPer100);

   g_lm.MagicFilter     =InpMagicFilter;
   g_lm.S2TrigPips      =InpS2TrigPips;
   g_lm.S2LockPips      =InpS2LockPips;
   g_lm.S3TrigPips      =InpS3TrigPips;
   g_lm.S3LockPips      =InpS3LockPips;
   g_lm.LotPer100       =lotPer100;
   g_lm.SyncSL          =InpSyncSL;
   g_lm.SyncTP          =InpSyncTP;
   g_lm.RetryCooldownSec=InpRetryCooldownSec;
   g_lm.Journal         =InpJournal;
   g_lm.PipSize         =InpPipSize;
   g_lm.BEMinPips       =InpBEMinPips;
   g_lm.BEBufferPips    =InpBEBufferPips;
   // timeframe / input change: the EA never stopped, so the ladder was not "restarted"
   g_lm.MarkRestart     =(UninitializeReason()!=REASON_CHARTCHANGE && UninitializeReason()!=REASON_PARAMETERS);
   g_lm.Init();

   if(UninitializeReason()!=REASON_CHARTCHANGE)
      Print("[LM] GOLD LADDER MANAGER v",LM_VERSION," ON ",_Symbol,
            " | managing ",(InpMagicFilter==0?"your manual trades":"magic "+(string)InpMagicFilter),
            " | cap ",DoubleToString(g_lm.LotCap(),2)," lot per ladder, max ",LM_MAX," ladders",
            " | BE from +",DoubleToString(InpBEMinPips,0)," pips (avg +",DoubleToString(InpBEBufferPips,0)," pip)",
            " | S2 +",DoubleToString(g_lm.S2TrigPips,0)," -> +",DoubleToString(g_lm.S2LockPips,0),
            " | S3 +",DoubleToString(g_lm.S3TrigPips,0)," -> +",DoubleToString(g_lm.S3LockPips,0)," then runner is yours",
            " | your SL edits always win",
            (InpJournal ? " | journal ON" : " | journal OFF"));

   BuildPanel();
   EventSetTimer(1);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   if(InpLiveBridge && reason!=REASON_CHARTCHANGE) FileDelete(StateFile(),FILE_COMMON);   // live app sees "EA off"
   g_lm.JournalDeinit(reason);
   if(g_drag) ChartSetInteger(0,CHART_MOUSE_SCROLL,g_scrollWas);
   SavePanel();
   ObjectsDeleteAll(0,"GLM_");
}

void OnTick()
{
   g_lm.Run();
   if(GetTickCount()-g_lastPanel>300) { RefreshPanel(); g_lastPanel=GetTickCount(); }
   if(GetTickCount()-g_lastState>250) WriteLiveState();
}

void OnTimer()
{
   ReadLiveCommand();
   g_lm.Run();
   RefreshPanel();
   WriteLiveState();
}

void OnTradeTransaction(const MqlTradeTransaction &trans,const MqlTradeRequest &req,const MqlTradeResult &res)
{
   g_lm.Run();
   RefreshPanel();
   WriteLiveState();
}

void OnChartEvent(const int id,const long &lparam,const double &dparam,const string &sparam)
{
   //--- drag the panel by its title bar
   if(id==CHARTEVENT_MOUSE_MOVE)
   {
      int  mx=(int)lparam, my=(int)dparam;
      bool left=((StringToInteger(sparam)&1)==1);
      if(left && !g_prevLeft && !g_drag && InTitleBar(mx,my))
      {
         g_drag=true; g_offx=mx-g_x; g_offy=my-g_y;
         g_scrollWas=(bool)ChartGetInteger(0,CHART_MOUSE_SCROLL);
         ChartSetInteger(0,CHART_MOUSE_SCROLL,false);
      }
      else if(g_drag && left)
      {
         g_x=mx-g_offx; g_y=my-g_offy; Clamp(); Layout();
      }
      else if(g_drag && !left)
      {
         g_drag=false;
         ChartSetInteger(0,CHART_MOUSE_SCROLL,g_scrollWas);
         SavePanel();
      }
      g_prevLeft=left;
      return;
   }
   if(id==CHARTEVENT_CHART_CHANGE) { Clamp(); Layout(); return; }

   if(id==CHARTEVENT_OBJECT_CLICK)
   {
      if(StringFind(sparam,"GLM_")==0 && ObjectGetInteger(0,sparam,OBJPROP_TYPE)==OBJ_BUTTON)
         ObjectSetInteger(0,sparam,OBJPROP_STATE,false);
      if(sparam=="GLM_MIN") { g_min=!g_min; SavePanel(); BuildPanel(); return; }
      if(sparam=="GLM_SM")  { if(g_scIdx>0) g_scIdx--; SavePanel(); BuildPanel(); return; }
      if(sparam=="GLM_SP")  { if(g_scIdx<ArraySize(SCALES)-1) g_scIdx++; SavePanel(); BuildPanel(); return; }
      if(sparam=="GLM_PREV") { g_lm.PagePrev(); RefreshPanel(); return; }
      if(sparam=="GLM_NEXT") { g_lm.PageNext(); RefreshPanel(); return; }
      if(sparam=="GLM_NEW")
      {
         string msg;
         if(g_lm.NewLadder(msg)) Print("[LM] NEW LADDER ",msg);
         else                    Print("[LM] NEW LADDER refused - ",msg);
         RefreshPanel();
         return;
      }
      if(sparam=="GLM_BE")
      {
         string msg;
         if(g_lm.MoveToBE(msg)) Print("[LM] ",msg);
         else                   Print("[LM] MOVE TO BE refused - ",msg);
         RefreshPanel();
         return;
      }
      return;
   }

   if(id!=CHARTEVENT_OBJECT_ENDEDIT || StringFind(sparam,"GLM_E_")!=0) return;
   string key=StringSubstr(sparam,6);
   int idx=-1;
   for(int i=0;i<ArraySize(EDIT_KEYS);i++) if(EDIT_KEYS[i]==key) { idx=i; break; }
   if(idx<0) return;

   double oldV=GetSetting(key);
   string txt=ObjectGetString(0,sparam,OBJPROP_TEXT);
   StringReplace(txt,",",".");
   double v=StringToDouble(txt);
   string why=SetSetting(key,v);
   if(why!="")
   {
      Print("[LM] SETTING refused: ",EDIT_NAMES[idx]," ",txt," - ",why,". Kept ",Fmt(oldV));
      ObjectSetString(0,sparam,OBJPROP_TEXT,Fmt(oldV));
   }
   else if(MathAbs(v-oldV)>1e-9)
   {
      Print("[LM] SETTING ",EDIT_NAMES[idx]," ",Fmt(oldV)," -> ",Fmt(v)," (applies from the next event)");
      ObjectSetString(0,sparam,OBJPROP_TEXT,Fmt(v));
   }
   RefreshPanel();
}
//+------------------------------------------------------------------+
