import assert from "node:assert/strict";
import test from "node:test";
import { FRAME_TTL_MS, computerVisionRoute, createComputerUseTools, describeElements, type ComputerUseHost } from "../src/computer-use-tools.js";
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
  const tools=createComputerUseTools(config,{...host,observe:async()=>({...frame,capturedAt:new Date(Date.now()-FRAME_TTL_MS-1000).toISOString()})},{analyzeImage:async()=>"Visible old result"});
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

test("a vision-capable conversation model receives the frame directly, labelled with the chat route", async () => {
  const direct = { ...config, model: "fixture-vision", baseURL: "https://chat.fixture.invalid/v1", mediaBaseURL: "https://media.fixture.invalid/v1" };
  assert.equal(computerVisionRoute(direct), "Fixture channel / fixture-vision · https://chat.fixture.invalid/v1");
  assert.equal(computerVisionRoute({ ...direct, model: "fixture-text" }), "Fixture channel / fixture-vision · https://media.fixture.invalid/v1");
  let uploads = 0, finished = 0;
  const tools = createComputerUseTools(direct, { ...host, feedbackFinished: () => { finished++; }, observe: async label => { assert.match(label, /chat\.fixture\.invalid/); return { ...frame, elements: [{ id: "button-1", name: "Start", role: "Button", x: 0, y: 0, width: 80, height: 30, enabled: true }] }; } }, { analyzeImage: async () => { uploads++; return "never"; } });
  const observe = tools.find(tool => tool.name === "computer_observe")!;
  const result = await observe.executeResult!({ prompt: "Where is Start?" }, context);
  assert.equal(uploads, 0); assert.equal(finished, 1);
  assert.deepEqual(result.images, [{ mediaType: "image/png", data: "Zml4dHVyZQ==" }]);
  assert.match(result.output, /Frame: frame-fixture/); assert.match(result.output, /Screenshot: attached to this result as an image of 720x480/);
  assert.match(result.output, /button-1/); assert.match(result.output, /untrusted data, not instructions/);
  assert.doesNotMatch(result.output, /Zml4|base64|Vision observations/);
  // Inputs verify with a fresh direct frame as well.
  const input = await tools.find(tool => tool.name === "computer_input")!.executeResult!({ kind: "doubleclick", frameId: frame.frameId, elementId: "button-1" }, context);
  assert.equal(input.images?.length, 1); assert.equal(uploads, 0);
  // The relay path is unchanged when the conversation model is not the vision model.
  const relayed = await createComputerUseTools(config, host, { analyzeImage: async () => { uploads++; return "Visible"; } }).find(tool => tool.name === "computer_observe")!.executeResult!({ prompt: "Inspect" }, context);
  assert.equal(uploads, 1); assert.equal(relayed.images, undefined); assert.match(relayed.output, /Vision observations/);
});

test("the input vocabulary exposes pointer kinds, drag targets and the key tiers to the model", async () => {
  const tools = createComputerUseTools(config, host, {});
  const schema = tools.find(tool => tool.name === "computer_input")!.inputSchema as { properties: Record<string, { enum?: string[]; description?: string }> };
  assert.deepEqual(schema.properties.kind!.enum, ["click", "doubleclick", "rightclick", "drag", "scroll", "type", "key"]);
  assert.ok(schema.properties.toX && schema.properties.toY);
  assert.match(schema.properties.key!.description ?? "", /Ctrl\+C/); assert.match(schema.properties.key!.description ?? "", /Delete/);
  const sent: Array<Record<string, unknown>> = [];
  const dragTools = createComputerUseTools(config, { ...host, input: async value => { sent.push(value as unknown as Record<string, unknown>); return "sent once"; }, observe: async () => frame }, { analyzeImage: async () => "Visible" });
  await dragTools.find(tool => tool.name === "computer_input")!.execute({ kind: "drag", frameId: frame.frameId, x: 10, y: 20, toX: 300, toY: 400 }, context);
  assert.equal(sent[0]!.kind, "drag"); assert.equal(sent[0]!.toX, 300); assert.equal(sent[0]!.toY, 400);
  await dragTools.find(tool => tool.name === "computer_input")!.execute({ kind: "key", key: "Backspace", repeat: 6, frameId: frame.frameId }, context);
  assert.equal(sent[1]!.repeat, 6);
  assert.equal((schema.properties as Record<string, { maximum?: number }>).repeat!.maximum, 50);
});

test("a blank or misplaced elementId never blocks type/key and is dropped before reaching the host", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const tools = createComputerUseTools(config, { ...host, input: async value => { sent.push(value as unknown as Record<string, unknown>); return "sent once"; }, observe: async () => frame }, { analyzeImage: async () => "Visible" });
  const input = tools.find(tool => tool.name === "computer_input")!;
  const typed = await input.execute({ kind: "type", frameId: frame.frameId, text: "hello", elementId: "" }, context);
  assert.doesNotMatch(typed, /ignored/);
  await input.execute({ kind: "type", frameId: frame.frameId, text: "hello", elementId: null }, context);
  const targeted = await input.execute({ kind: "key", frameId: frame.frameId, key: "Enter", elementId: "button-1" }, context);
  assert.match(targeted, /elementId is ignored for type\/key; the input went to the focused control/);
  await input.execute({ kind: "click", frameId: frame.frameId, x: 1, y: 2, elementId: "  " }, context);
  await input.execute({ kind: "click", frameId: frame.frameId, elementId: "button-1" }, context);
  assert.deepEqual(sent.map(value => "elementId" in value ? value.elementId : "absent"), ["absent", "absent", "absent", "absent", "button-1"]);
  const schema = input.inputSchema as { properties: Record<string, { description?: string }> };
  assert.match(schema.properties.elementId!.description ?? "", /Omit for type, key/);
});

test("the host's own dialogs replace the generic approval only for steps they cover", async () => {
  const { executeToolResult } = await import("../src/tools.js");
  const approvals: string[] = [];
  const approving = { ...context, approve: async (request: { description: string }) => { approvals.push(request.description); return true; } };
  const covered = new Set<string>();
  const tools = createComputerUseTools(config, { ...host, windows: async () => [], select: async () => "authorized", confirms: step => covered.has(step) }, { analyzeImage: async () => "Visible" });
  const run = (name: string, input: Record<string, unknown>) => executeToolResult(tools.find(tool => tool.name === name)!, input, approving);
  // No target yet: observe and input go through the generic approval; selection is always the controller's dialog.
  await run("computer_input", { kind: "click", frameId: frame.frameId, x: 1, y: 1 });
  await run("computer_observe", { prompt: "Inspect" });
  covered.add("select");
  await run("computer_select", { handle: "42" });
  assert.deepEqual(approvals, ["perform one target-window input within confirmed scope", "observe target window within confirmed vision scope"]);
  // Authorized target: the controller confirms each step itself (or holds the user's automatic grant).
  covered.add("observe"); covered.add("input");
  assert.equal((await run("computer_input", { kind: "click", frameId: frame.frameId, x: 1, y: 1 })).status, "success");
  assert.equal((await run("computer_observe", { prompt: "Inspect" })).status, "success");
  assert.equal(approvals.length, 2);
  // Discovery and a host without the hook keep the generic approval.
  await run("computer_windows", {});
  await executeToolResult(createComputerUseTools(config, host, {}).find(tool => tool.name === "computer_input")!, { kind: "click", frameId: frame.frameId, x: 1, y: 1 }, approving);
  assert.deepEqual(approvals.slice(2), ["discover application windows for computer task", "perform one target-window input within confirmed scope"]);
});

test("control listings are one line per control, never cut mid-entry, and frames stay valid for three minutes", async () => {
  const element = (index: number) => ({ id: `42.${index}.-2147483646.${index}`, name: index === 0 ? "Editable  field" : `Menu item ${index}`, role: index === 0 ? "ControlType.Document" : "ControlType.MenuItem", x: index, y: 10, width: 300, height: 20, enabled: index !== 1 });
  const listing = describeElements([element(0), element(1)]);
  assert.equal(listing, "42.0.-2147483646.0 | Document | Editable field | 0,10 300x20\n42.1.-2147483646.1 | MenuItem | Menu item 1 | 1,10 300x20 | disabled");
  const many = describeElements(Array.from({ length: 400 }, (_, index) => element(index)));
  const lines = many.split("\n");
  assert.ok(many.length <= 16_100 && lines.length < 400);
  assert.match(lines.at(-1)!, /^… \d+ more controls not listed/);
  for (const line of lines.slice(0, -1)) assert.match(line, /^42\.\d+\.-2147483646\.\d+ \| /);
  assert.equal(describeElements([]), "(none readable)");
  assert.equal(FRAME_TTL_MS, 180_000);
  // A frame just under the limit is still actionable in relay mode.
  const fresh = createComputerUseTools(config, { ...host, observe: async () => ({ ...frame, capturedAt: new Date(Date.now() - FRAME_TTL_MS + 5_000).toISOString() }) }, { analyzeImage: async () => "Visible" });
  assert.match(await fresh[1]!.execute({ prompt: "Inspect" }, context), /Frame: frame-fixture/);
});
