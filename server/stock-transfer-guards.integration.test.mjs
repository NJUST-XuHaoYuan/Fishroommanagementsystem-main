import assert from "node:assert/strict";
import test from "node:test";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";
import { stockTransferFixture, TRANSFER_TEST_PASSWORD } from "./test-support/stock-transfer-fixture.mjs";

const ok = (result) => assert.equal(result.response.status, 200, JSON.stringify(result.body));
const byId = (state, id) => state.stock.find((item) => item.id === id);
const expected = (item) => ({
  id: item.id,
  subTankId: item.subTankId,
  status: item.status,
  lost: Boolean(item.lost),
  tankTransferId: item.tankTransfer?.id ?? "",
});

test("a revoked administrator cannot execute a pending stock approval", async (t) => {
  const fixture = structuredClone(stockPricingFixture);
  const server = await startMutableRouteServer(fixture);
  t.after(() => server.stop());
  const admin = await server.login("pricing-admin", PRICING_TEST_PASSWORD);
  const editor = await server.login("pricing-editor", PRICING_TEST_PASSWORD);
  const before = await server.readPersistedState();
  const fish = byId(before, "follower");
  const submitted = await server.request("/api/stock/save", {
    token: editor,
    body: {
      upsert: [{ ...fish, notes: "待审批修改" }],
      deleteIds: [],
      expectedOperations: { [fish.id]: "update" },
      expectedBefore: { [fish.id]: fish },
    },
  });
  ok(submitted);
  assert.equal(submitted.body.pendingApproval, true);
  await server.patchTestPersonnel("pricing-admin", { accessRole: "staff", permissions: {} });
  const decision = await server.request("/api/approvals/stock", {
    token: admin,
    body: { requestId: submitted.body.approvalRequestId, decision: "approve" },
  });
  assert.ok([401, 403].includes(decision.response.status), JSON.stringify(decision.body));
  const after = await server.readPersistedState();
  assert.equal(byId(after, fish.id).notes, fish.notes);
  assert.equal(after.approvalRequests.find((request) => request.id === submitted.body.approvalRequestId).status, "pending");
});

test("an active transfer freezes bio edits and retains its source tank until receipt", async (t) => {
  const fixture = stockTransferFixture();
  const sourceGroup = fixture.state.tankGroups.find((group) => group.id === "group-n");
  sourceGroup.subTanks.push({ id: "tank-transfer-source", name: "PRIVATE_SOURCE_TANK" });
  byId(fixture.state, "unrelated-fish").subTankId = "tank-transfer-source";
  const server = await startMutableRouteServer(fixture);
  t.after(() => server.stop());
  const admin = await server.login("pricing-admin", TRANSFER_TEST_PASSWORD);
  const receiver = await server.login("receiver", TRANSFER_TEST_PASSWORD);
  const fish = byId(await server.readPersistedState(), "unrelated-fish");
  const issue = await server.request("/api/maintenance/save", {
    token: admin,
    body: {
      mode: "transferIssue",
      clientMutationId: "guard-issue",
      itemIds: [fish.id],
      expectedItems: [expected(fish)],
      moveNotes: "guard test",
    },
  });
  ok(issue);

  for (const body of [
    {
      action: "create",
      stockItemId: fish.id,
      record: { id: "bio-bypass", date: "2026-10-18T09:00", text: "bypass", photos: [], videos: [] },
    },
    {
      action: "saveDetails",
      stockItemId: fish.id,
      details: { status: "feeding" },
      expectedDetails: { status: fish.status },
    },
  ]) {
    const result = await server.request("/api/bio-records/save", { token: admin, body });
    assert.equal(result.response.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.code, "STOCK_IN_TRANSFER");
  }

  const deletion = await server.request("/api/tank-groups/save", {
    token: admin,
    body: { mode: "deleteSubTank", groupId: sourceGroup.id, subTankId: "tank-transfer-source" },
  });
  assert.equal(deletion.response.status, 409, JSON.stringify(deletion.body));
  assert.equal(deletion.body.code, "TANK_IN_TRANSIT_SOURCE_REFERENCED");
  let state = await server.readPersistedState();
  assert.ok(state.tankGroups.find((group) => group.id === sourceGroup.id).subTanks
    .some((tank) => tank.id === "tank-transfer-source"));
  assert.equal(byId(state, fish.id).status, fish.status);
  assert.equal(byId(state, fish.id).tankTransfer.status, "in_transit");

  const receipt = await server.request("/api/maintenance/save", {
    token: receiver,
    body: {
      mode: "transferReceive",
      clientMutationId: "guard-receipt",
      targetSubTankId: "tank-j",
      items: [{ stockItemId: fish.id, transferId: byId(state, fish.id).tankTransfer.id }],
    },
  });
  ok(receipt);

  const targetState = await server.request("/api/state", { token: receiver });
  ok(targetState);
  const targetFish = byId(targetState.body.data, fish.id);
  assert.equal(targetFish.tankTransfer.status, "received", "the current site needs the latest snapshot for CAS and reissue");
  assert.doesNotMatch(JSON.stringify(targetState.body.data.bioRecords), /PRIVATE_SOURCE_TANK|guard test/);
  const history = await server.request(`/api/bio-records?stockItemId=${encodeURIComponent(fish.id)}`, { token: receiver });
  ok(history);
  assert.doesNotMatch(JSON.stringify(history.body.bioRecords), /PRIVATE_SOURCE_TANK|guard test/);

  const ordinaryEdit = await server.request("/api/stock/save", {
    token: receiver,
    body: {
      upsert: [{ ...targetFish, notes: "received edit" }],
      deleteIds: [],
      expectedOperations: { [fish.id]: "update" },
      expectedBefore: { [fish.id]: targetFish },
    },
  });
  ok(ordinaryEdit);
  assert.equal(ordinaryEdit.body.pendingApproval, true);

  const reissue = await server.request("/api/maintenance/save", {
    token: receiver,
    body: {
      mode: "transferIssue",
      clientMutationId: "guard-reissue",
      itemIds: [fish.id],
      expectedItems: [expected(targetFish)],
      moveNotes: "reissue from API snapshot",
    },
  });
  ok(reissue);
  assert.equal(reissue.body.stockUpdates[0].tankTransfer.status, "in_transit");
});
