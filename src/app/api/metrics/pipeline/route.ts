import { NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';

export const dynamic = 'force-dynamic';

function getStripeKey(): string | null {
  try {
    const configPath = join(process.cwd(), '..', 'config', 'stripe.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return config.secret_key;
  } catch {
    return process.env.CASHFLOW_STRIPE_KEY || process.env.STRIPE_SECRET_KEY || null;
  }
}

interface PipelineEntry {
  name: string;
  email: string | null;
  depositDate: string;
  daysSinceDeposit: number;
  lowValue: number;  // if they choose rev share path ($1,500 remainder)
  highValue: number; // if they choose buyout path ($4,000 remainder)
}

export async function GET() {
  try {
    const stripeKey = getStripeKey();
    if (!stripeKey) {
      return NextResponse.json({ openDeposits: [], totalLow: 0, totalHigh: 0 });
    }

    const res = await fetch('https://api.stripe.com/v1/charges?limit=100', {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });

    if (!res.ok) throw new Error(`Stripe error ${res.status}`);
    const data = await res.json();

    const charges = (data.data || []).filter((c: { status: string }) => c.status === 'succeeded');

    // Group by name
    const byName: Record<string, { amounts: number[]; dates: number[]; email: string | null }> = {};
    for (const c of charges) {
      const name = (c.billing_details?.name || c.receipt_email || 'Unknown').trim();
      const email = c.billing_details?.email || c.receipt_email || null;
      if (!byName[name]) byName[name] = { amounts: [], dates: [], email };
      byName[name].amounts.push(c.amount / 100);
      byName[name].dates.push(c.created);
    }

    // Find open deposits: paid $1K deposit but no remainder ($1,500 or $4,000) yet
    const openDeposits: PipelineEntry[] = [];
    const now = Date.now() / 1000;

    for (const [name, data] of Object.entries(byName)) {
      const hasDeposit = data.amounts.includes(1000);
      const hasRemainder = data.amounts.some(a => a === 1500 || a === 4000);
      if (hasDeposit && !hasRemainder) {
        const depositTimestamp = Math.min(...data.dates.filter((_, i) => data.amounts[i] === 1000));
        const depositDate = new Date(depositTimestamp * 1000).toISOString().split('T')[0];
        const daysSince = Math.floor((now - depositTimestamp) / 86400);
        openDeposits.push({
          name,
          email: data.email,
          depositDate,
          daysSinceDeposit: daysSince,
          lowValue: 1500,
          highValue: 4000,
        });
      }
    }

    // Sort by oldest first (most urgent)
    openDeposits.sort((a, b) => a.depositDate.localeCompare(b.depositDate));

    const totalLow = openDeposits.reduce((s, d) => s + d.lowValue, 0);
    const totalHigh = openDeposits.reduce((s, d) => s + d.highValue, 0);

    return NextResponse.json({
      openDeposits,
      totalLow,
      totalHigh,
      count: openDeposits.length,
    });
  } catch (error) {
    console.error('Pipeline fetch error:', error);
    return NextResponse.json({ openDeposits: [], totalLow: 0, totalHigh: 0, count: 0 });
  }
}
