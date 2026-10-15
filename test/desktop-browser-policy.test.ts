import assert from "node:assert/strict";
import test from "node:test";
import { BrowserNetworkPolicy } from "../apps/desktop/main/browser-network-policy.js";

function policyWith(answers: Record<string, string[][]>): { policy: BrowserNetworkPolicy; lookups: string[] } {
  const lookups: string[] = [];
  const policy = new BrowserNetworkPolicy(async (hostname) => {
    lookups.push(hostname);
    const queue = answers[hostname];
    if (!queue?.length) throw new Error(`ENOTFOUND ${hostname}`);
    return queue.length > 1 ? queue.shift()! : queue[0]!;
  });
  return { policy, lookups };
}

test("web tab policy allows public HTTPS GET/HEAD and rejects other methods and schemes", async () => {
  const { policy } = policyWith({ "example.com": [["93.184.216.34"]] });
  assert.equal(await policy.check("https://example.com/page", "GET"), "allow");
  assert.equal(await policy.check("https://example.com/page", "head"), "allow");
  assert.equal(await policy.check("https://example.com/page", "POST"), "method");
  assert.equal(await policy.check("http://example.com/page"), "policy");
  assert.equal(await policy.check("https://user:pw@example.com/"), "policy");
  assert.equal(await policy.check("not a url"), "unparseable");
  assert.equal(await policy.check("https://10.0.0.8/admin"), "policy");
  assert.equal(await policy.check("https://localhost/"), "policy");
  assert.deepEqual([...policy.taintedHosts], []);
});

test("a host that rebinds to a private address is blocked and stays blocked for the session", async () => {
  const { policy, lookups } = policyWith({ "rebind.test": [["203.0.113.5"], ["192.168.1.20"], ["203.0.113.5"]] });
  assert.equal(await policy.check("https://rebind.test/"), "allow");
  // The second answer points inside the network: cancelled and remembered.
  assert.equal(await policy.check("https://rebind.test/api/internal"), "private");
  assert.deepEqual([...policy.taintedHosts], ["rebind.test"]);
  // Flipping back to a public address does not reopen the host, and no new lookup is spent on it.
  assert.equal(await policy.check("https://rebind.test/"), "tainted");
  assert.equal(await policy.check("https://REBIND.test./other", "HEAD"), "tainted");
  assert.equal(lookups.length, 2);
});

test("a mixed public and private answer, an IPv6-mapped private address and a failed lookup are all cancelled", async () => {
  const { policy } = policyWith({
    "mixed.test": [["203.0.113.5", "127.0.0.1"]],
    "mapped.test": [["::ffff:10.1.2.3"]],
    "empty.test": [[]],
  });
  assert.equal(await policy.check("https://mixed.test/"), "private");
  assert.equal(await policy.check("https://mapped.test/"), "private");
  assert.equal(await policy.check("https://empty.test/"), "policy");
  assert.equal(await policy.check("https://missing.test/"), "policy");
  assert.deepEqual([...policy.taintedHosts].sort(), ["mapped.test", "mixed.test"]);
});

test("the tab explains a private-address block differently from an ordinary policy block", () => {
  assert.match(BrowserNetworkPolicy.message("private"), /本机或内网地址/);
  assert.equal(BrowserNetworkPolicy.message("tainted"), BrowserNetworkPolicy.message("private"));
  assert.match(BrowserNetworkPolicy.message("policy"), /公开 HTTPS/);
  assert.match(BrowserNetworkPolicy.message("method"), /公开 HTTPS/);
});
