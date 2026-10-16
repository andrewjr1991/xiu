using System;

// Compiled with the production bridge; no desktop interaction or test branches in production.
class ComputerEditorCommandTests {
  static void Check(bool value,string message) { if(!value)throw new Exception(message); }
  static int Main() {
    try {
      var handle=new IntPtr(42);
      foreach(string name in new[]{"Edit","edit","RichEdit","RichEdit20A","RichEdit20W","RICHEDIT50W","WindowsForms10.EDIT.app.0.abc_r6_ad1","WindowsForms10.RichEdit20W.app.0.abc"}) {
        foreach(string key in new[]{"Ctrl+A","Ctrl+C","Ctrl+V","Ctrl+Z"}) {
          bool verified=false;int sent=0;
          bool routed=ComputerEditorCommands.TrySend(key,()=>{verified=true;return handle;},h=>{Check(verified&&h==handle,"class read before editor verification");return name;},(h,m,l)=>{Check(verified&&h==handle,"unverified message target");sent++;});
          Check(routed&&sent==1,"native edit command must dispatch exactly once: "+name+" "+key);
        }
      }
      Console.WriteLine("PASS classic editors use one message after verification");
      foreach(string name in new[]{"Chrome_RenderWidgetHostHWND","Chrome_WidgetWin_1","Windows.UI.Core.CoreWindow","Microsoft.UI.Content.DesktopChildSiteBridge","Button","CustomEdit","EditExtra","RichEditUnknown","WindowsForms10.Window.8.app.0.abc","WindowsForms10.EDIT.unknown", "", null}) {
        foreach(string key in new[]{"Ctrl+A","Ctrl+C","Ctrl+V","Ctrl+Z"}) {
          int messages=0,keyboard=0;
          if(!ComputerEditorCommands.TrySend(key,()=>handle,h=>name,(h,m,l)=>messages++))keyboard++;
          Check(messages==0&&keyboard==1,"unsupported class must choose keyboard before any message: "+name);
        }
      }
      Console.WriteLine("PASS non-classic/unknown classes take keyboard path without a message");
      foreach(string key in new[]{"Ctrl+S","Ctrl+Y","Shift+Home"}) {
        int editorChecks=0,keyboard=0;
        if(!ComputerEditorCommands.TrySend(key,()=>{editorChecks++;throw new Exception("editor required");},h=>"Edit",(h,m,l)=>{throw new Exception("unexpected message");}))keyboard++;
        Check(editorChecks==0&&keyboard==1,"non-message keys must not enter editor-message guard: "+key);
      }
      Console.WriteLine("PASS Ctrl+S bypasses the editor-message guard (caller still applies key approval)");
      int forbiddenMessages=0,forbiddenKeys=0;var denied=new Exception("editor-control-required");
      try {
        if(!ComputerEditorCommands.TrySend("Ctrl+V",()=>{throw denied;},h=>"Edit",(h,m,l)=>forbiddenMessages++))forbiddenKeys++;
        throw new Exception("missing editor rejection");
      } catch(Exception e) { Check(object.ReferenceEquals(e,denied),"editor denial changed or swallowed"); }
      Check(forbiddenMessages==0&&forbiddenKeys==0,"editor rejection must not dispatch or fall back");
      Console.WriteLine("PASS unverified editor cannot dispatch either path");
      foreach(string key in new[]{"Ctrl+A","Ctrl+C","Ctrl+V","Ctrl+Z"}) {
        int attempts=0,keyboard=0;var unknown=new Exception("input-blocked-or-partial-do-not-retry");
        try {
          if(!ComputerEditorCommands.TrySend(key,()=>handle,h=>"Edit",(h,m,l)=>{attempts++;throw unknown;}))keyboard++;
          throw new Exception("missing timeout failure");
        } catch(Exception e) { Check(object.ReferenceEquals(e,unknown),"send failure changed or swallowed"); }
        Check(attempts==1&&keyboard==0,"unknown message result must not replay as a key");
      }
      Console.WriteLine("PASS message timeout/error never replays as keyboard input");
      int classReads=0,missingMessages=0;
      Check(!ComputerEditorCommands.TrySend("Ctrl+A",()=>IntPtr.Zero,h=>{classReads++;return "Edit";},(h,m,l)=>missingMessages++),"missing HWND must not use message route");
      Check(classReads==0&&missingMessages==0,"missing HWND must not be queried or sent a message");
      return 0;
    } catch(Exception e) { Console.Error.WriteLine(e.Message);return 1; }
  }
}
