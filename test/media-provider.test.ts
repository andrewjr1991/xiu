import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../src/config.js";
import { createMediaBackend } from "../src/media.js";

test("Windows vision trusts enterprise roots without disabling certificate verification", {skip: process.platform !== "win32" || typeof tls.getCACertificates !== "function"}, async(t)=>{
  const directory=await mkdtemp(path.join(tmpdir(),"xiu-vision-tls-"));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const key=path.join(directory,"fixture.key"),cert=path.join(directory,"fixture.crt");
  execFileSync("C:/Program Files/Git/usr/bin/openssl.exe",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","1","-subj","/CN=127.0.0.1","-addext","subjectAltName=IP:127.0.0.1"],{stdio:"ignore",windowsHide:true});
  const certificate=await readFile(cert,"utf8");
  const server=createHttpsServer({key:await readFile(key),cert:certificate},async(request,response)=>{
    for await(const _chunk of request){ /* consume synthetic fixture request */ }
    response.setHeader("Content-Type","application/json");
    response.end(JSON.stringify({id:"fixture",object:"chat.completion",choices:[{index:0,message:{role:"assistant",content:"TLS_FIXTURE_SEEN"},finish_reason:"stop"}]}));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  const address=server.address();if(!address||typeof address==="string")throw Error("No fixture server");
  const roots=tls.getCACertificates.bind(tls);
  t.mock.method(tls,"getCACertificates",(type?:"default"|"system"|"bundled"|"extra")=>type==="system"?[certificate]:roots(type));
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const config={provider:"openai-compatible",providerId:"openai-compatible",model:"fixture",apiKey:"fixture",baseURL:`https://127.0.0.1:${address.port}`,cwd:directory,autoApprove:false} satisfies AgentConfig;
  const backend=createMediaBackend(config,{maxRetries:0});
  assert.equal(await backend.analyzeImage!("Inspect synthetic fixture","data:image/png;base64,Zml4dHVyZQ=="),"TLS_FIXTURE_SEEN");
  // A different root is not accepted: adding system roots is not TLS bypass.
  t.mock.restoreAll();syncBuiltinESMExports();
  const rejected=createMediaBackend(config,{maxRetries:0});
  await assert.rejects(rejected.analyzeImage!("Inspect synthetic fixture","data:image/png;base64,Zml4dHVyZQ=="));
});

for (const provider of ["openai-compatible", "anthropic"] as const) test(`${provider} visual probes disable SDK retries`, async (t) => {
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain fixture */ }
    requests++; response.statusCode = 500; response.setHeader("content-type", "application/json"); response.end('{"error":{"message":"fixture error","type":"api_error"}}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture failed");
  const backend = createMediaBackend({ provider, providerId: provider, model: "manual-vision-id", capabilities: { text: "manual-vision-id", vision: "manual-vision-id" }, apiKey: "fixture", baseURL: `http://127.0.0.1:${address.port}/v1`, cwd: process.cwd(), autoApprove: false }, { maxRetries: 0 });
  await assert.rejects(backend.analyzeImage!("Inspect", "data:image/png;base64,Zml4dHVyZQ=="));
  assert.equal(requests, 1);
});

test("Anthropic vision uses the declared media destination rather than another endpoint", async (t) => {
  let called = false;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain fixture body */ }
    assert.equal(request.url, "/v1/messages"); called = true;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({id:"fixture",type:"message",role:"assistant",model:"fixture",content:[{type:"text",text:"Visible fixture"}],stop_reason:"end_turn",usage:{input_tokens:1,output_tokens:1}}));
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(() => new Promise<void>((resolve,reject) => server.close(error=>error?reject(error):resolve())));
  const address=server.address(); if (!address || typeof address === "string") throw new Error("No fixture server");
  const backend=createMediaBackend({provider:"anthropic",providerId:"anthropic",model:"fixture",capabilities:{text:"fixture",vision:"fixture"},apiKey:"fixture",mediaBaseURL:`http://127.0.0.1:${address.port}`,cwd:process.cwd(),autoApprove:false});
  assert.equal(await backend.analyzeImage!("Inspect","data:image/png;base64,Zml4dHVyZQ=="),"Visible fixture");
  assert.equal(called,true);
});

test("OpenAI-compatible media backend routes image, video, and audio to the configured vendor", async (t) => {
  const requests: Array<{ method: string; url: string; authorization?: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ method: request.method ?? "", url: request.url ?? "", authorization: request.headers.authorization, body });
    if (request.url === "/v1/images/generations") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ b64_json: Buffer.from("image-bytes").toString("base64") }] }));
    } else if (request.url === "/v1/audio/speech") {
      response.setHeader("content-type", "audio/mpeg");
      response.end("audio-bytes");
    } else if (request.url === "/v1/videos" && request.method === "POST") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "video-1", status: "completed", progress: 100 }));
    } else if (request.url === "/v1/videos/video-1/content") {
      response.setHeader("content-type", "video/mp4");
      response.end("video-bytes");
    } else {
      response.statusCode = 404;
      response.end("missing");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  const config: AgentConfig = {
    provider: "openai-compatible", providerId: "vendor", model: "vendor-chat", cwd: process.cwd(), autoApprove: false,
    apiKey: "vendor-secret", baseURL, mediaBaseURL: baseURL,
    providerFeatures: { text: true, tools: true, vision: true, image: true, video: true, audio: true },
    capabilities: { text: "vendor-chat", vision: "vendor-vision", image: "vendor-image", video: "vendor-video", audio: "vendor-audio" },
  };
  const backend = createMediaBackend(config);
  const image = await backend.generateImage!({ prompt: "draw", size: "1K", ratio: "1:1" });
  const audio = await backend.generateAudio!({ text: "speak", format: "mp3" });
  const video = await backend.createVideo!({ prompt: "move" });
  const videoBytes = await backend.download!(video.url!);

  assert.equal(Buffer.from(image.b64Json!, "base64").toString("utf8"), "image-bytes");
  assert.equal(audio.toString("utf8"), "audio-bytes");
  assert.equal(videoBytes.toString("utf8"), "video-bytes");
  assert.deepEqual(requests.map((item) => `${item.method} ${item.url}`), [
    "POST /v1/images/generations", "POST /v1/audio/speech", "POST /v1/videos", "GET /v1/videos/video-1/content",
  ]);
  assert.ok(requests.every((item) => item.authorization === "Bearer vendor-secret"));
  assert.match(requests[0]!.body, /vendor-image/);
  assert.match(requests[1]!.body, /vendor-audio/);
  assert.match(requests[2]!.body, /vendor-video/);
});
