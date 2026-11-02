// Offline demo: a pet chats 3 times; shows the reply, cost and the reply hash
// the backend would pass to `charge`. Usage: node scripts/chat-mock.mjs [msg]
import { chat, sha256, verifyReply } from '../lib/chat.mjs';
import { createAiClient } from '../lib/ai.mjs';

const prompt = 'Cheerful moss creature who loves rain.';
const pet = { token_id: '0', name: 'Mochi', prompt, prompt_hash: sha256(prompt), balance: 10n ** 23n, asleep: false };
const client = createAiClient();
const fmt = (y) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(6);
console.log(`pet ${pet.name} prompt_hash=${pet.prompt_hash} balance=${fmt(pet.balance)} NEAR ai=${client.mock ? 'mock' : client.model}`);
for (const msg of process.argv[2] ? [process.argv[2]] : ['hi', 'what do you eat?', 'goodnight']) {
  const r = await chat(pet, msg, { client });
  pet.balance = BigInt(pet.balance) - BigInt(r.cost);
  console.log(`\n> ${msg}\n${r.reply}\ncost=${fmt(r.cost)} NEAR balance=${fmt(pet.balance)} NEAR`);
  console.log(`charge ${JSON.stringify(r.chargeArgs)} verify=${verifyReply(r.receipt, r.replyHash)}`);
}
