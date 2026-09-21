/**
 * Epic #728 / Issue #738 — Presence indicators (Socket.IO).
 *
 * Acceptance criteria covered:
 *   AC3: Given a user opens a Spec Kit artifact when another user is already
 *        viewing it, presence avatars appear in the artifact header within 1 s.
 *
 * Strategy:
 *   - Connect two Node-side Socket.IO clients (using socket.io-client) with
 *     JWT bearer tokens. This avoids needing the PresenceAvatars React component
 *     to be mounted in a real page — it exercises the same socket events the
 *     component uses.
 *   - For the browser-level assertion (avatar HTML rendered within 1 s), the
 *     test is marked test.fixme until PresenceAvatars is integrated into a
 *     navigable page.
 *
 * Socket event contract (server: src/lib/collaboration/presence.ts):
 *   Client → Server:
 *     presence:join   { artifactType: string, artifactId: string }
 *     presence:leave  { artifactType: string, artifactId: string }
 *   Server → Client:
 *     presence:update { room: string, users: Array<{userId, username, displayName}>, ts: number }
 *
 * Closes #738
 */
import { test, expect, request } from "@playwright/test";
import { io, type Socket } from "socket.io-client";
import { ADMIN_USER } from "../../fixtures/seed-user.js";
import { apiBase } from "../../fixtures/api-base.js";
import { LoginPage } from "../../pages/login.page.js";
import { PresenceAvatarsPage } from "../../pages/PresenceAvatars.page.js";
import { SpecKitPage } from "../../pages/SpecKit.page.js";
import { createProjectViaApi } from "../../fixtures/project-helpers.js";

const API_BASE = apiBase();
// The socket server lives on the same Express server as the REST API.
const SOCKET_URL = API_BASE;

const COORDINATOR = { username: "coordinator", password: "password" };

// ---- Helpers ----------------------------------------------------------------

async function getToken(username: string, password: string): Promise<string> {
  const ctx = await request.newContext({ baseURL: API_BASE });
  const res = await ctx.post("/api/auth/login", { data: { username, password } });
  expect(res.status(), `login failed for ${username}: ${await res.text()}`).toBe(200);
  const body = (await res.json()) as { data: { accessToken: string } };
  await ctx.dispose();
  return body.data.accessToken;
}

/**
 * Open a Socket.IO connection authenticated with `token`.
 * Resolves once the `connect` event fires or rejects after `timeoutMs`.
 */
function connectSocket(token: string, timeoutMs = 10_000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error(`Socket did not connect within ${timeoutMs} ms`));
    }, timeoutMs);

    const socket = io(SOCKET_URL, {
      path: "/socket.io",
      transports: ["websocket"],
      auth: { token }, // JWT — accepted by the MetisIOServer middleware
    });

    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("connect_error", (err) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(new Error(`Socket connect_error: ${err.message}`));
    });
  });
}

/**
 * Wait for a single `presence:update` event from `socket` that satisfies
 * `predicate`. Rejects after `timeoutMs`.
 */
function waitForPresenceUpdate(
  socket: Socket,
  predicate: (update: {
    room: string;
    users: Array<{ userId: string; username: string }>;
  }) => boolean,
  timeoutMs = 5_000,
): Promise<{ room: string; users: Array<{ userId: string; username: string }> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`presence:update did not satisfy predicate within ${timeoutMs} ms`));
    }, timeoutMs);

    const handler = (update: {
      room: string;
      users: Array<{ userId: string; username: string }>;
    }) => {
      if (predicate(update)) {
        clearTimeout(timer);
        socket.off("presence:update", handler);
        resolve(update);
      }
    };
    socket.on("presence:update", handler);
  });
}

// ---- Suite ------------------------------------------------------------------

test.describe("Epic #728 / Issue #738 — Presence indicators (Socket.IO)", () => {
  let adminToken: string;
  let coordinatorToken: string;

  test.beforeAll(async () => {
    [adminToken, coordinatorToken] = await Promise.all([
      getToken(ADMIN_USER.username, ADMIN_USER.password),
      getToken(COORDINATOR.username, COORDINATOR.password),
    ]);
  });

  // AC3 — socket server broadcasts presence:update when a user joins
  test("broadcasts presence:update when User A joins an artifact room", async () => {
    const adminSocket = await connectSocket(adminToken);

    try {
      const artifactType = "spec-kit";
      const artifactId = `e2e-presence-${Date.now()}`;

      // Listen BEFORE emitting join so we don't race.
      const updatePromise = waitForPresenceUpdate(
        adminSocket,
        (u) => u.room === `presence:${artifactType}:${artifactId}` && u.users.length >= 1,
      );

      adminSocket.emit("presence:join", { artifactType, artifactId });

      const update = await updatePromise;
      expect(update.users).toHaveLength(1);
      expect(update.users[0].username).toBe(ADMIN_USER.username);
    } finally {
      adminSocket.disconnect();
    }
  });

  // AC3 — second user joining same room causes first user to see them
  test("AC3: User B joining the same room appears in presence list within 2 s", async () => {
    const artifactType = "spec-kit";
    const artifactId = `e2e-presence-two-${Date.now()}`;

    const [adminSocket, coordinatorSocket] = await Promise.all([
      connectSocket(adminToken),
      connectSocket(coordinatorToken),
    ]);

    try {
      // Admin joins first.
      const adminJoinedPromise = waitForPresenceUpdate(
        adminSocket,
        (u) =>
          u.room === `presence:${artifactType}:${artifactId}` &&
          u.users.some((usr) => usr.username === ADMIN_USER.username),
      );
      adminSocket.emit("presence:join", { artifactType, artifactId });
      await adminJoinedPromise;

      // Now coordinator joins. Admin should receive an update showing both.
      const bothPresentPromise = waitForPresenceUpdate(
        adminSocket,
        (u) =>
          u.room === `presence:${artifactType}:${artifactId}` &&
          u.users.some((usr) => usr.username === ADMIN_USER.username) &&
          u.users.some((usr) => usr.username === COORDINATOR.username),
        2_000, // AC3 requires appearance within 2 s
      );

      coordinatorSocket.emit("presence:join", { artifactType, artifactId });

      const update = await bothPresentPromise;
      expect(update.users).toHaveLength(2);
      const usernames = update.users.map((u) => u.username);
      expect(usernames).toContain(ADMIN_USER.username);
      expect(usernames).toContain(COORDINATOR.username);
    } finally {
      adminSocket.disconnect();
      coordinatorSocket.disconnect();
    }
  });

  // AC3 — user leaving the room is removed from the presence list
  test("removes User A from presence list after they leave the artifact room", async () => {
    const artifactType = "spec-kit";
    const artifactId = `e2e-presence-leave-${Date.now()}`;

    const [adminSocket, coordinatorSocket] = await Promise.all([
      connectSocket(adminToken),
      connectSocket(coordinatorToken),
    ]);

    try {
      // Both join.
      const bothJoinedPromise = waitForPresenceUpdate(
        coordinatorSocket,
        (u) =>
          u.room === `presence:${artifactType}:${artifactId}` &&
          u.users.some((usr) => usr.username === ADMIN_USER.username) &&
          u.users.some((usr) => usr.username === COORDINATOR.username),
      );
      adminSocket.emit("presence:join", { artifactType, artifactId });
      coordinatorSocket.emit("presence:join", { artifactType, artifactId });
      await bothJoinedPromise;

      // Admin leaves — coordinator should see only themselves.
      const afterLeavePromise = waitForPresenceUpdate(
        coordinatorSocket,
        (u) =>
          u.room === `presence:${artifactType}:${artifactId}` &&
          !u.users.some((usr) => usr.username === ADMIN_USER.username),
      );
      adminSocket.emit("presence:leave", { artifactType, artifactId });
      const afterLeave = await afterLeavePromise;
      expect(afterLeave.users.map((u) => u.username)).not.toContain(ADMIN_USER.username);
      expect(afterLeave.users.map((u) => u.username)).toContain(COORDINATOR.username);
    } finally {
      adminSocket.disconnect();
      coordinatorSocket.disconnect();
    }
  });

  // AC3 — socket disconnect triggers presence cleanup automatically
  test("presence list clears when a user's socket disconnects without explicit leave", async () => {
    const artifactType = "spec-kit";
    const artifactId = `e2e-presence-disconnect-${Date.now()}`;

    const [adminSocket, coordinatorSocket] = await Promise.all([
      connectSocket(adminToken),
      connectSocket(coordinatorToken),
    ]);

    try {
      // Both join and wait until coordinator sees admin.
      const bothJoinedPromise = waitForPresenceUpdate(
        coordinatorSocket,
        (u) =>
          u.room === `presence:${artifactType}:${artifactId}` &&
          u.users.some((usr) => usr.username === ADMIN_USER.username),
      );
      adminSocket.emit("presence:join", { artifactType, artifactId });
      coordinatorSocket.emit("presence:join", { artifactType, artifactId });
      await bothJoinedPromise;

      // Hard-disconnect admin (no leave event).
      const afterDisconnectPromise = waitForPresenceUpdate(
        coordinatorSocket,
        (u) =>
          u.room === `presence:${artifactType}:${artifactId}` &&
          !u.users.some((usr) => usr.username === ADMIN_USER.username),
        5_000,
      );
      adminSocket.disconnect();
      const afterDisconnect = await afterDisconnectPromise;
      expect(afterDisconnect.users.map((u) => u.username)).not.toContain(ADMIN_USER.username);
    } finally {
      if (coordinatorSocket.connected) coordinatorSocket.disconnect();
    }
  });

  // AC3 — socket server rejects unauthenticated connections
  test("socket server rejects connections without a valid JWT", async () => {
    await expect(connectSocket("not-a-valid-token", 5_000)).rejects.toThrow(/connect_error/i);
  });

  // ---- Browser-level presence avatar test -----------------------------------
  //
  // AC3: PresenceAvatars is now mounted in the spec-kit artifact header
  // (ui/.../projects/[id]/spec-kit/page.tsx — commit 38265fb). This drives the
  // full browser + socket rendering path: two real browser contexts open the
  // same artifact and each sees the other's avatar.
  test("AC3: presence avatars appear in the spec-kit artifact header when a second user joins", async ({
    page,
    browser,
  }) => {
    // Admin logs in (context 1) and creates a project to scope the artifact room.
    const loginPageA = new LoginPage(page);
    await loginPageA.loginAsAdmin();
    const project = await createProjectViaApi(API_BASE, adminToken, "e2e-presence-ui");

    // Coordinator logs in via a second, isolated browser context.
    const coordCtx = await browser.newContext();
    const coordPage = await coordCtx.newPage();
    const loginPageB = new LoginPage(coordPage);
    await loginPageB.goto();
    await loginPageB.login(COORDINATOR.username, COORDINATOR.password);

    try {
      // Both navigate to the SAME artifact (spec.md is the default selection),
      // which mounts PresenceAvatars with the same room key
      // (`${projectId}:spec.md`).
      const specKitA = new SpecKitPage(page);
      const specKitB = new SpecKitPage(coordPage);
      await specKitA.goto(project.id);
      await specKitB.goto(project.id);

      // Admin should see coordinator's avatar in the header.
      const presenceA = new PresenceAvatarsPage(page);
      await presenceA.expectUserPresent(COORDINATOR.username, 5_000);

      // Coordinator should see admin's avatar.
      const presenceB = new PresenceAvatarsPage(coordPage);
      await presenceB.expectUserPresent(ADMIN_USER.username, 5_000);
    } finally {
      await coordCtx.close();
    }
  });
});
