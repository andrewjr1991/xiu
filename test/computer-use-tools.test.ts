import assert from "node:assert/strict";
import test from "node:test";
import { computerVisionRoute, createComputerUseTools, type ComputerUseHost } from "../src/computer-use-tools.js";
import type { AgentConfig } from "../src/config.js";
import type { ToolContext } from "../src/types.js";

const config: AgentConfig = { provider: "openai", providerId: "fixture", providerLabel: "Fixture channel", model: "fixture", capabilities: { text: "fixture", vision: "fixture-vision" }, cwd: ".", language: "en-US", autoApprove: false };
const context: ToolContext = { cwd: ".", approve: async () => false };
const frame = { image: "data:image/png;base64,Zml4dHVyZQ==", frameId: "frame-fixture", width: 720, height: 480 };
const host: ComputerUseHost = { observe: async () => frame, input: async () => "sent once", status: () => "authorized fixture" };

test("merged consent route matches observation and excludes URL credentials/query", async () => {
  const routed = { ...config, baseURL: "https://user:password@fixture.invalid/v1/?token=secret" };
  const route = computerVisionRoute(routed);
  assert.equal(route, "Fixture channel / fixture-vision · https://fixture.invalid/v1");
  const tools = createComputerUseTools(routed, { ...host, observe: async value => { assert.equal(value, route); return frame; } }, { analyzeImage: async () => "visible" });
  await tools.find(tool => tool.name === "computer_observe")!.execute({ prompt: "Observe fixture" }, context);
});

test("status leaves vision analysis after completion or failure", async () => {
  let finished = 0;
  for (const fails of [false, true]) {
    const tools = createComputerUseTools(config, { ...host, feedbackFinished: () => { finished++; } }, { analyzeImage: async () => { if (fails) throw new Error("fixture vision failure"); return "visible"; } });
    const result = tools.find(tool => tool.name === "computer_observe")!.execute({ prompt: "Observe fixture" }, context);
    if (fails) await assert.rejects(result, /fixture vision failure/); else await result;
  }
  assert.equal(finished, 2);
});

test("computer tools are target-scoped, independently approved and never replay inputs", () => {
  const tools = createComputerUseTools(config, host, {});
  assert.deepEqual(tools.map(tool => tool.name), ["computer_status", "computer_observe", "computer_input"]);
  assert.equal(tools[2]!.risk, "dangerous");
  for (const tool of tools) assert.equal(tool.maxAttempts, 1);
  assert.equal(tools[1]!.replaySafety, "side-effecting"); assert.equal(tools[2]!.replaySafety, "side-effecting");
  assert.doesNotMatch(tools[2]!.describe({ text: "private typed fixture" }), /private typed/);
});

test("vision consent names actual route, uses only authorized frame and returns no image bytes", async () => {
  const calls: string[] = [];
  const tools = createComputerUseTools(config, { ...host, observe: async label => { calls.push(label); return frame; } }, {
    analyzeImage: async (prompt, image) => { calls.push("uploaded"); assert.equal(image, frame.image); assert.match(prompt,/720x480/); assert.match(prompt,/untrusted/); return "Visible fixture target at (50, 90)"; },
  });
  const output = await tools[1]!.execute({prompt:"Locate fixture target"},context);
  assert.match(calls[0]!, /^Fixture channel \/ fixture-vision · https:/);
  assert.equal(calls[1], "uploaded");
  assert.match(output,/frame-fixture/);assert.match(output,/not deterministic test evidence/);assert.doesNotMatch(output,/base64|Zml4/);
  assert.match(output,/Control inspection: unavailable; .*user is asked/);
  const inspected = await createComputerUseTools(config, { ...host, observe: async () => ({ ...frame, inspection: "partial" }) }, { analyzeImage: async () => "visible" })[1]!.execute({prompt:"Locate"},context);
  assert.match(inspected,/Control inspection: partial; unlisted controls may include password fields/);
});

test("discovery and selection use trusted access mode, not model arguments", async () => {
  const grants: boolean[] = [];
  const tools = createComputerUseTools(config, { ...host, windows: async () => [{handle:"42",title:"Fixture",app:"fixture",width:720,height:480}], select:async (_handle,_route,full) => {grants.push(full);return "authorized";} }, {});
  assert.match(await tools.find(t=>t.name==="computer_windows")!.execute({},context),/Fixture/);
  const select=tools.find(t=>t.name==="computer_select")!;
  await select.execute({handle:"42",fullAccess:true},context);
  await select.execute({handle:"42"},{...context,accessMode:"full"});
  assert.deepEqual(grants,[false,true]);
});

test("input verifies afterward and never replays when observation fails", async () => {
  let inputs=0;
  const tools=createComputerUseTools(config,{...host,input:async value=>{inputs++;assert.equal(value.elementId,"button-1");return "sent once";},observe:async()=>{throw new Error("vision unavailable");}},{analyzeImage:async()=>""});
  const result=await tools[2]!.execute({kind:"click",frameId:frame.frameId,elementId:"button-1",verificationQuestion:"Did it start?"},context);
  assert.equal(inputs,1);assert.match(result,/unverified|not verified|unavailable/i);
});

test("successful input observation provides the next fresh frame and visible controls", async () => {
  const calls: string[]=[];
  const tools=createComputerUseTools(config,{...host,input:async()=>{calls.push("input");return "sent once";},observe:async()=>{calls.push("observe");return {...frame,frameId:"next-frame",elements:[{id:"visible-button",name:"Start",role:"Button",x:0,y:0,width:80,height:30,enabled:true}]};}},{analyzeImage:async()=>{calls.push("vision");return "Visible result";}});
  const result=await tools[2]!.execute({kind:"key",key:"Space",frameId:frame.frameId,verificationQuestion:"What changed?"},context);
  assert.deepEqual(calls,["input","observe","vision"]);
  assert.match(result,/next-frame/);assert.match(result,/visible-button/);assert.match(result,/Visible result/);
});

test("default input feedback captures once without requiring an explicit question", async () => {
  let captures=0, inputs=0;
  const tools=createComputerUseTools(config,{...host,input:async value=>{inputs++;assert.equal('verificationDelayMs' in value,false);return 'sent once';},observe:async()=>{captures++;return frame;}},{analyzeImage:async()=>"Visible result"});
  const result=await tools[2]!.execute({kind:"key",key:"Space",frameId:frame.frameId,verificationDelayMs:0},context);
  assert.equal(inputs,1);assert.equal(captures,1);assert.match(result,/Post-action observation/);
});

test("invalid delays reject before capture or input", async () => {
  let calls=0;
  const tools=createComputerUseTools(config,{...host,input:async()=>{calls++;return ''},observe:async()=>{calls++;return frame;}},{analyzeImage:async()=>''});
  for(const delay of [-1,3001,0.5,"100",null]) {
    await assert.rejects(tools[1]!.execute({prompt:"Inspect",delayMs:delay},context),/delay/i);
    await assert.rejects(tools[2]!.execute({kind:"key",frameId:frame.frameId,key:"Space",verificationDelayMs:delay},context),/delay/i);
  }
  assert.equal(calls,0);
});

test("cancelling a settling wait prevents a late capture or upload", async () => {
  let calls=0;const cancel=new AbortController();
  const tools=createComputerUseTools(config,{...host,observe:async()=>{calls++;return frame;}},{analyzeImage:async()=>{calls++;return ''}});
  const pending=tools[1]!.execute({prompt:"Inspect",delayMs:3000},{...context,signal:cancel.signal});
  cancel.abort();await assert.rejects(pending,/cancelled/i);assert.equal(calls,0);
});

test("cancelling after input prevents delayed feedback but never repeats the sent input", async () => {
  let captures=0,inputs=0;const cancel=new AbortController();
  const tools=createComputerUseTools(config,{...host,input:async()=>{inputs++;cancel.abort();return 'sent once';},observe:async()=>{captures++;return frame;}},{analyzeImage:async()=>''});
  const result=await tools[2]!.execute({kind:"key",frameId:frame.frameId,key:"Space",verificationDelayMs:3000},{...context,signal:cancel.signal});
  assert.equal(inputs,1);assert.equal(captures,0);assert.match(result,/WAS sent/);
});

test("slow vision responses do not expose expired frame IDs as actionable", async () => {
  const tools=createComputerUseTools(config,{...host,observe:async()=>({...frame,capturedAt:new Date(Date.now()-61000).toISOString()})},{analyzeImage:async()=>"Visible old result"});
  const result=await tools[1]!.execute({prompt:"Inspect"},context);
  assert.match(result,/expired/i);assert.doesNotMatch(result,/Frame: frame-fixture/);
});

test("declined upload never calls provider", async () => {
  let uploads = 0;
  const tools = createComputerUseTools(config, { ...host, observe: async () => { throw new Error("declined"); } }, { analyzeImage: async () => { uploads++; return ""; } });
  await assert.rejects(tools[1]!.execute({prompt:"Inspect"},context),/declined/);assert.equal(uploads,0);
});

test("cancel after local capture prevents upload", async () => {
  const cancel = new AbortController(); let uploads = 0;
  const tools = createComputerUseTools(config, { ...host, observe: async () => { cancel.abort(); return frame; } }, { analyzeImage: async () => { uploads++; return ""; } });
  await assert.rejects(tools[1]!.execute({prompt:"Inspect"},{...context,signal:cancel.signal}),/cancelled/);assert.equal(uploads,0);
});

test("unsupported vision fails before capturing or asking upload consent", async () => {
  let captures = 0;
  const tools = createComputerUseTools({...config,providerFeatures:{text:true,tools:true,vision:false,image:false,video:false,audio:false}}, {...host,observe:async()=>{captures++;return frame;}}, {analyzeImage:async()=>""});
  await assert.rejects(tools[1]!.execute({prompt:"Inspect"},context),/no vision/);assert.equal(captures,0);
});

test("unknown input outcomes propagate once without retries", async () => {
  let inputs = 0;
  const tools = createComputerUseTools(config,{...host,input:async()=>{inputs++;throw new Error("unknown outcome");}},{});
  await assert.rejects(tools[2]!.execute({kind:"click",frameId:frame.frameId,x:50,y:90},context),/unknown outcome/);assert.equal(inputs,1);
});

test("bounded observation question rejects before capture", async () => {
  let captures = 0;
  const tools=createComputerUseTools(config,{...host,observe:async()=>{captures++;return frame;}},{});
  for(const prompt of ["", " ", "x".repeat(4001), 12]) await assert.rejects(tools[1]!.execute({prompt},context),/bounded/);
  assert.equal(captures,0);
});

test("vision prose is bounded and cancellation does not claim successful observation", async () => {
  const cancel=new AbortController();
  const tools=createComputerUseTools(config,host,{analyzeImage:async()=>"x".repeat(20000)});
  const result=await tools[1]!.execute({prompt:"Inspect"},context);assert.ok(result.length<12500);
  const stopped=createComputerUseTools(config,host,{analyzeImage:async()=>{cancel.abort();return "passed";}});
  await assert.rejects(stopped[1]!.execute({prompt:"Inspect"},{...context,signal:cancel.signal}),/cancelled/);
});

test("a screenshot is uploaded exactly once even when the vision request fails", async () => {
  const http = await import("node:http");
  let requests = 0;
  const server = http.createServer((_request, response) => { requests++; response.statusCode = 500; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ error: { message: "fixture outage" } })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const tools = createComputerUseTools({ ...config, baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture" }, host);
    await assert.rejects(tools.find(tool => tool.name === "computer_observe")!.execute({ prompt: "Observe fixture" }, context), /fixture outage|500/);
    assert.equal(requests, 1);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
