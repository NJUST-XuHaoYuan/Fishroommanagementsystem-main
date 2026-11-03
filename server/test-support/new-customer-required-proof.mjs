import assert from "node:assert/strict";
import { evidencePng, EVIDENCE_TEST_KEYRING } from "./new-customer-evidence-fixture.mjs";

export const requiredProofEnv = { PERSONNEL_DATA_KEYRING_JSON: EVIDENCE_TEST_KEYRING };

export async function uploadRequiredProof(server, token, orderId) {
  const response = await fetch(`${server.baseUrl}/api/orders/new-customer/evidence?orderId=${encodeURIComponent(orderId)}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/png", "x-file-name": encodeURIComponent("添加微信证明.png") }, body: evidencePng(),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.attachment;
}
