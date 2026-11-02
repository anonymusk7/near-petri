// pnpm preflight: live, free attestation check (no completion is sent).
// Needs MOCK_AI=0 and NEAR_AI_API_KEY in the environment.
import { createAiClient } from '../lib/ai.mjs';

const client = createAiClient({ mock: false });
const { summary: s } = await client.preflight();
console.log(`model ${s.model}  nonce ${s.nonce}`);
console.log(`gateway ${s.gateway.signing_address} (${s.gateway.signing_algo}) TCB ${s.gateway.tcb_status} compose ${s.gateway.compose_hash}`);
for (const m of s.models) {
  console.log(`model   ${m.signing_address} (${m.signing_algo}) TCB ${m.tcb_status} compose ${m.compose_hash} GPU ${m.gpu.gpus}x${m.gpu.arch} NRAS overall=${m.gpu.overall}`);
}
console.log('preflight OK: quotes (dcap-qvl), report_data = signer||nonce, MRCONFIGID, RTMR3 replay, NRAS JWT');
