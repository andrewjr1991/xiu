using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using System.Web.Script.Serialization;
// Isolated test application. No user application or real data is touched.
class ComputerWindowFixture {
  [STAThread] static void Main(string[] args) {
    var form = new Form { Text="Xiu isolated window fixture", ClientSize=new Size(480,320), StartPosition=FormStartPosition.CenterScreen, BackColor=Color.White };
    var text=new TextBox { Location=new Point(20,20), Size=new Size(280,30) };
    var button=new Button { Text="Fixture click", Location=new Point(20,70), Size=new Size(160,40) };
    var dangerous=new Button { Text="Delete fixture", Location=new Point(20,130), Size=new Size(160,40) };
    var load=new Button { Text="Load fixture", Location=new Point(20,190), Size=new Size(160,40) };
    var status=new Label { Text="Not loaded", Location=new Point(200,195), Size=new Size(220,40) };
    var loading=new Timer { Interval=500 }; bool ready=false;
    int clicks=0, keys=0, wheels=0; string lastKey="";
    Action save=()=>File.WriteAllText(args[0],new JavaScriptSerializer().Serialize(new { text=text.Text, clicks=clicks, keys=keys, wheels=wheels, ready=ready, selectionStart=text.SelectionStart, selectionLength=text.SelectionLength,lastKey=lastKey }));
    load.Click+=(s,e)=>{ready=false;status.Text="Loading";save();loading.Start();};
    loading.Tick+=(s,e)=>{loading.Stop();ready=true;status.Text="Ready";save();};
    button.Click+=(s,e)=>{clicks++;save();}; text.TextChanged+=(s,e)=>save();
    text.KeyDown+=(s,e)=>{keys++;lastKey=e.KeyData.ToString();save();}; text.KeyUp+=(s,e)=>save(); form.MouseWheel+=(s,e)=>{wheels++;save();};
    form.Controls.Add(text);form.Controls.Add(button);form.Controls.Add(dangerous);form.Controls.Add(load);form.Controls.Add(status);
    form.Shown+=(s,e)=>{form.Activate();text.Focus();save();};
    Application.Run(form);
  }
}
