/**
 * Rotation of the daemon's stdout log.
 *
 * The bug: `~/.omniroute/logs/omniroute.log` reached 54 MB while
 * `omniroute.log.1` … `.5` all sat at 0 bytes. Three independent causes, all
 * verified in the tree:
 *
 *  1. `initLogRotation()` has had no production caller since the pino logger was
 *     replaced by a console shim, and it targets `logs/application/app.log`
 *     anyway — a different file.
 *  2. The `.1`-`.5` rotation in `scripts/dev/run-headless.mjs` runs once at
 *     startup and only on the Node entrypoint; the live daemon execs
 *     `bun src/server/headless/server-elysia.ts`.
 *  3. Both existing implementations use `renameSync`. launchd owns the fd for
 *     this file and does not reopen on rename, so a rename moves the inode the
 *     writer keeps appending to — the archive would keep growing and the live
 *     path would not exist.
 *
 * The inode-preservation test below is the load-bearing one: it is the property
 * that a rename-based rotation cannot satisfy.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  rotateStdoutLog,
  startStdoutLogRotation,
  stopStdoutLogRotation,
  resolveStdoutLogPath,
  openAppendFd,
  closeFd,
  fdPointsAtSameFile,
} = await import("@/lib/stdoutLogRotation");

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-logrot-"));
}

test("a log under the threshold is left alone", () => {
  const dir = tmpdir();
  const log = path.join(dir, "omniroute.log");
  fs.writeFileSync(log, "x".repeat(100));
  const result = rotateStdoutLog(log, 1000, 5);
  assert.equal(result.rotated, false);
  assert.equal(result.reason, "under-threshold");
  assert.equal(fs.statSync(log).size, 100);
  assert.equal(fs.existsSync(`${log}.1`), false);
});

test("a log at the threshold is archived and truncated", () => {
  const dir = tmpdir();
  const log = path.join(dir, "omniroute.log");
  const content = "y".repeat(2000);
  fs.writeFileSync(log, content);

  const result = rotateStdoutLog(log, 1000, 5);
  assert.equal(result.rotated, true);
  assert.equal(result.bytes, 2000);
  // The archive holds the content ...
  assert.equal(fs.readFileSync(`${log}.1`, "utf8"), content);
  // ... and the live file is empty but STILL PRESENT.
  assert.equal(fs.existsSync(log), true);
  assert.equal(fs.statSync(log).size, 0);
});

test("REGRESSION: rotation preserves the inode, so a supervisor's open fd keeps working", () => {
  // This is the property `renameSync` cannot provide, and the reason
  // omniroute.log grew to 54 MB while its archives stayed empty. launchd holds
  // an O_APPEND fd; if rotation moves the inode, launchd keeps filling the
  // archive and the live path stops existing.
  const dir = tmpdir();
  const log = path.join(dir, "omniroute.log");
  fs.writeFileSync(log, "z".repeat(2000));

  const fd = openAppendFd(log); // stand-in for launchd's descriptor
  try {
    assert.equal(fdPointsAtSameFile(fd, log), true, "precondition");

    const result = rotateStdoutLog(log, 1000, 5);
    assert.equal(result.rotated, true);

    // The descriptor must still refer to the live path after rotation.
    assert.equal(
      fdPointsAtSameFile(fd, log),
      true,
      "the writer's fd must still point at the live log after rotation"
    );

    // And a write through that same fd must land in the live file, not the archive.
    fs.writeSync(fd, "after-rotation\n");
    assert.equal(fs.readFileSync(log, "utf8"), "after-rotation\n");
    assert.equal(fs.readFileSync(`${log}.1`, "utf8"), "z".repeat(2000));
  } finally {
    closeFd(fd);
  }
});

test("archives shift up and the oldest is dropped", () => {
  const dir = tmpdir();
  const log = path.join(dir, "omniroute.log");
  fs.writeFileSync(`${log}.1`, "one");
  fs.writeFileSync(`${log}.2`, "two");
  fs.writeFileSync(`${log}.3`, "three");
  fs.writeFileSync(log, "n".repeat(2000));

  assert.equal(rotateStdoutLog(log, 1000, 3).rotated, true);

  assert.equal(fs.readFileSync(`${log}.1`, "utf8"), "n".repeat(2000)); // new archive
  assert.equal(fs.readFileSync(`${log}.2`, "utf8"), "one");
  assert.equal(fs.readFileSync(`${log}.3`, "utf8"), "two");
  assert.equal(fs.existsSync(`${log}.4`), false); // maxFiles honoured
  // "three" was the oldest at maxFiles and is gone.
});

test("repeated rotations keep working", () => {
  const dir = tmpdir();
  const log = path.join(dir, "omniroute.log");
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(log, `round${i}`.padEnd(2000, "."));
    assert.equal(rotateStdoutLog(log, 1000, 5).rotated, true, `round ${i}`);
    assert.equal(fs.statSync(log).size, 0);
  }
  assert.ok(fs.readFileSync(`${log}.1`, "utf8").startsWith("round2"));
  assert.ok(fs.readFileSync(`${log}.2`, "utf8").startsWith("round1"));
  assert.ok(fs.readFileSync(`${log}.3`, "utf8").startsWith("round0"));
});

test("a missing log is reported, not thrown", () => {
  const dir = tmpdir();
  const result = rotateStdoutLog(path.join(dir, "nope.log"), 1, 5);
  assert.equal(result.rotated, false);
  assert.equal(result.reason, "missing");
});

test("the periodic rotator fires on start and can be stopped", () => {
  const dir = tmpdir();
  const log = path.join(dir, "omniroute.log");
  fs.writeFileSync(log, "q".repeat(20 * 1024 * 1024)); // over the 10MB default
  try {
    // Startup tick must catch a file that is ALREADY oversized — the live file
    // was 54 MB when this was written.
    assert.equal(startStdoutLogRotation(log, 60_000), true);
    assert.equal(fs.statSync(log).size, 0, "the startup tick must rotate immediately");
    assert.equal(fs.statSync(`${log}.1`).size, 20 * 1024 * 1024);
  } finally {
    stopStdoutLogRotation();
  }
});

test("the stdout log path is resolved only when the file really exists", () => {
  const dir = tmpdir();
  const saved = process.env.OMNIROUTE_STDOUT_LOG;
  delete process.env.OMNIROUTE_STDOUT_LOG;
  try {
    // Nothing there — must not invent a path to rotate.
    assert.equal(resolveStdoutLogPath(dir), null);

    fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "logs", "omniroute.log"), "");
    assert.equal(resolveStdoutLogPath(dir), path.join(dir, "logs", "omniroute.log"));

    // An explicit override wins.
    process.env.OMNIROUTE_STDOUT_LOG = "/custom/path.log";
    assert.equal(resolveStdoutLogPath(dir), "/custom/path.log");
  } finally {
    if (saved === undefined) delete process.env.OMNIROUTE_STDOUT_LOG;
    else process.env.OMNIROUTE_STDOUT_LOG = saved;
  }
});
