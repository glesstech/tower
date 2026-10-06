// Lease expiry: a cleared plan whose agent has gone silent (crashed, hung, lost its session)
// is released automatically, so the airspace it holds doesn't stay locked forever. Every agent
// call on a plan (poll, check, amend, land, heartbeat) refreshes its last_seen_at; a Durable
// Object alarm expires cleared plans silent for longer than their TTL, the way release does.

import { type Core, type Plan, type PlanRow, plan as getPlan, serial, toPlan } from "./core";
import { bump } from "./events";
import { close } from "./plans";

const deadline = (p: Plan) => p.lastSeenAt + p.ttl * 1000;

// Mark a plan as seen. Closed plans are left alone; asking about one doesn't revive it.
export function touch(t: Core, id: string) {
	t.sql.exec("UPDATE plans SET last_seen_at = ? WHERE id = ? AND status IN ('holding', 'cleared')", Date.now(), id);
}

// POST /plans/:id/heartbeat: the touch itself happens in the router, like every plan call.
export function heartbeat(t: Core, id: string) {
	const plan = getPlan(t, id);
	if (plan.status !== "cleared" && plan.status !== "holding") throw new Error(`plan ${id} is ${plan.status}`);
	return { plan, expiresAt: plan.status === "cleared" ? deadline(plan) : null };
}

// A plan waiting in the review inbox has no agent to hear from; its lease is paused until a
// human decides (review.ts restarts it on send-back).
function cleared(t: Core): Plan[] {
	return t.sql
		.exec<PlanRow>("SELECT * FROM plans WHERE status = 'cleared' AND review IS NULL ORDER BY created_at")
		.toArray()
		.map(toPlan);
}

// Make sure the alarm fires by the earliest cleared plan's deadline. Heartbeats only push
// deadlines later, so an alarm that fires early just finds nothing due and reschedules.
export async function schedule(t: Core) {
	const plans = cleared(t);
	if (!plans.length) return;
	const next = Math.min(...plans.map(deadline));
	const current = await t.ctx.storage.getAlarm();
	if (current === null || current > next) await t.ctx.storage.setAlarm(next);
}

// The alarm: release every cleared plan past its deadline, then schedule the next check.
// Runs in the serial queue so it never races a land or release of the same plan.
export async function expire(t: Core) {
	await serial(t, async () => {
		for (const { id } of cleared(t)) {
			// Re-read: a heartbeat may have arrived, or an earlier expiry just cleared it fresh.
			const plan = getPlan(t, id);
			const now = Date.now();
			if (plan.status !== "cleared" || plan.review || deadline(plan) > now) continue;
			bump(t, "leases_expired");
			await close(t, plan, "expired", { silentFor: now - plan.lastSeenAt, ttl: plan.ttl });
		}
	});
	await schedule(t);
}
