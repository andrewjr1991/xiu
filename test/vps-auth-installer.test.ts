import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const installer = new URL("../scripts/install-xiu-search-auth-vps.sh", import.meta.url);
const dockerfile = new URL("../scripts/xiu-search-auth/Dockerfile", import.meta.url);
const dockerignore = new URL("../scripts/xiu-search-auth/.dockerignore", import.meta.url);

test("managed auth installer preserves an existing database and requires explicit migration", async () => {
  const source = await readFile(installer, "utf8");
  assert.match(source, /EXISTING_DATABASE_PATH="\$\(existing_value XIU_AUTH_DATABASE\)"/);
  assert.match(source, /DATABASE_PATH="\$\{DATABASE_PATH_OVERRIDE:-\$\{EXISTING_DATABASE_PATH:-\/data\/xiu-search-auth\.sqlite3\}\}"/);
  assert.match(source, /--migrate-database-from/);
  assert.match(source, /migrate --source "\$MIGRATE_DATABASE_FROM" --target "\$DATABASE_PATH" --apply/);
  assert.match(source, /inspect --target "\$DATABASE_PATH"/);
  assert.match(source, /AUTH_ENV_ROLLBACK_SOURCE="\$BACKUP_DIR\/auth\.env"/);
  assert.match(source, /已恢复升级前的 auth\.env/);
});

test("managed auth volume initialization is isolated from the long-running service", async () => {
  const source = await readFile(installer, "utf8");
  assert.match(source, /docker run --rm --network none --read-only --user 0/);
  assert.match(source, /--cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER/);
  assert.match(source, /--security-opt no-new-privileges=true/);
  assert.match(source, /docker run --rm --network none --read-only --user 10001:10001/);
  assert.match(source, /"\$\{COMPOSE\[@\]\}" stop auth\n/);
  assert.doesNotMatch(source, /stop auth \|\| true/);
  assert.match(source, /--memory 128m --memory-swap 128m --pids-limit 64/);
  const image = await readFile(dockerfile, "utf8");
  assert.match(image, /COPY migrate_database\.py \/app\/migrate_database\.py/);
  assert.match(image, /USER xiu/);
});

test("every file the auth image copies reaches the build context", async () => {
  const image = await readFile(dockerfile, "utf8");
  const sources = [...image.matchAll(/^COPY\s+(\S+)\s+/gm)].map((match) => match[1]);
  assert.ok(sources.length > 0);
  const ignore = (await readFile(dockerignore, "utf8")).split(/\r?\n/).map((line) => line.trim());
  assert.equal(ignore[0], "*");
  const script = await readFile(installer, "utf8");
  for (const source of sources) {
    assert.ok(ignore.includes(`!${source}`), `.dockerignore must allow ${source}`);
    assert.match(script, new RegExp(`"\\$SOURCE_DIR/${source.replace(/\./g, "\\.")}"`), `installer must copy ${source}`);
  }
});

test("database tools run in the image this install just built", async () => {
  const source = await readFile(installer, "utf8");
  assert.match(source, /^AUTH_IMAGE="xiu-search-auth:local"$/m);
  assert.match(source, /^    image: \$\{AUTH_IMAGE\}$/m);
  assert.match(source, /AUTH_IMAGE_ID="\$\(docker image inspect --format '\{\{\.Id\}\}' "\$AUTH_IMAGE"/);
  assert.doesNotMatch(source, /images -q auth/);
});
