import { NextRequest, NextResponse } from "next/server";
import { execute } from "@/lib/db";

// ---------------------------------------------------------------------------
// GET /api/metrics?start=YYYY-MM-DD&end=YYYY-MM-DD
//
// Computes real CEO Dashboard numbers from the database for the given date
// range, plus the same range shifted backward as the "previous period" for
// trend comparisons. Replaces the old hardcoded generateData() fake data.
//
// This is intentionally a starting point: `promote.channels`, `profit.funnels`,
// `produce.offers`, and per-segment `activeClients` counts return empty/zero
// until you add the richer tables + inserts for those breakdowns. The top-line
// numbers (revenue, sales, leads, event registrations, conversion rate,
// referrals, ad spend/ROAS) are real, computed from the `sales`, `leads`,
// `event_registrations`, and `ad_spend` tables below.
// ---------------------------------------------------------------------------

function daysBetween(a: Date, b: Date) {
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24)));
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const endStr = searchParams.get("end") || new Date().toISOString().split("T")[0];
    const startStr =
      searchParams.get("start") ||
      (() => {
        const d = new Date(endStr);
        d.setDate(d.getDate() - 30);
        return d.toISOString().split("T")[0];
      })();

    const start = new Date(startStr);
    const end = new Date(endStr);
    const days = daysBetween(start, end);

    // Previous period of equal length, immediately before `start`.
    const prevEnd = new Date(start);
    prevEnd.setDate(prevEnd.getDate() - 1);
    const prevStart = new Date(prevEnd);
    prevStart.setDate(prevStart.getDate() - (days - 1));

    const prevStartStr = prevStart.toISOString().split("T")[0];
    const prevEndStr = prevEnd.toISOString().split("T")[0];

    // End-of-day bound so the range is inclusive of the whole end date.
    const startBound = `${startStr} 00:00:00`;
    const endBound = `${endStr} 23:59:59`;
    const prevStartBound = `${prevStartStr} 00:00:00`;
    const prevEndBound = `${prevEndStr} 23:59:59`;

    const [
      revenueNow,
      revenuePrev,
      leadsNow,
      leadsPrev,
      regsNow,
      regsPrev,
      referralsNow,
      referralsPrev,
      adSpendNow,
    ] = await Promise.all([
      execute(
        `SELECT COUNT(*) as cnt, COALESCE(SUM(amount), 0) as total FROM sales WHERE created_at BETWEEN :s AND :e`,
        { s: startBound, e: endBound }
      ),
      execute(
        `SELECT COALESCE(SUM(amount), 0) as total FROM sales WHERE created_at BETWEEN :s AND :e`,
        { s: prevStartBound, e: prevEndBound }
      ),
      execute(
        `SELECT COUNT(*) as cnt FROM leads WHERE created_at BETWEEN :s AND :e`,
        { s: startBound, e: endBound }
      ),
      execute(
        `SELECT COUNT(*) as cnt FROM leads WHERE created_at BETWEEN :s AND :e`,
        { s: prevStartBound, e: prevEndBound }
      ),
      execute(
        `SELECT
           SUM(CASE WHEN event_type = 'webinar' THEN 1 ELSE 0 END) as webinar,
           SUM(CASE WHEN event_type = 'challenge' THEN 1 ELSE 0 END) as challenge,
           COUNT(*) as total
         FROM event_registrations WHERE created_at BETWEEN :s AND :e`,
        { s: startBound, e: endBound }
      ),
      execute(
        `SELECT COUNT(*) as cnt FROM event_registrations WHERE created_at BETWEEN :s AND :e`,
        { s: prevStartBound, e: prevEndBound }
      ),
      execute(
        `SELECT COUNT(*) as cnt FROM leads WHERE source = 'referral' AND created_at BETWEEN :s AND :e`,
        { s: startBound, e: endBound }
      ),
      execute(
        `SELECT COUNT(*) as cnt FROM leads WHERE source = 'referral' AND created_at BETWEEN :s AND :e`,
        { s: prevStartBound, e: prevEndBound }
      ),
      execute(
        `SELECT COALESCE(SUM(amount), 0) as spend, COALESCE(SUM(revenue_attributed), 0) as revenue
         FROM ad_spend WHERE created_at BETWEEN :s AND :e`,
        { s: startBound, e: endBound }
      ),
    ]);

    const revenueRow = revenueNow.rows[0] as unknown as { cnt: number; total: number };
    const revenuePrevTotal = Number((revenuePrev.rows[0] as unknown as { total: number })?.total ?? 0);
    const leadsCurrent = Number((leadsNow.rows[0] as unknown as { cnt: number })?.cnt ?? 0);
    const leadsPrevious = Number((leadsPrev.rows[0] as unknown as { cnt: number })?.cnt ?? 0);
    const regsRow = regsNow.rows[0] as unknown as { webinar: number; challenge: number; total: number };
    const regsPrevTotal = Number((regsPrev.rows[0] as unknown as { cnt: number })?.cnt ?? 0);
    const referralsCurrent = Number((referralsNow.rows[0] as unknown as { cnt: number })?.cnt ?? 0);
    const referralsPrevious = Number((referralsPrev.rows[0] as unknown as { cnt: number })?.cnt ?? 0);
    const adSpendRow = adSpendNow.rows[0] as unknown as { spend: number; revenue: number };

    const revenueCurrent = Number(revenueRow?.total ?? 0);
    const salesCount = Number(revenueRow?.cnt ?? 0);
    const conversionRateCurrent = leadsCurrent > 0 ? Math.round((salesCount / leadsCurrent) * 1000) / 10 : 0;
    // Previous-period conversion rate needs previous sales count too — reuse revenuePrev's row count via a light second query.
    const prevSalesCountRow = await execute(
      `SELECT COUNT(*) as cnt FROM sales WHERE created_at BETWEEN :s AND :e`,
      { s: prevStartBound, e: prevEndBound }
    );
    const prevSalesCount = Number((prevSalesCountRow.rows[0] as unknown as { cnt: number })?.cnt ?? 0);
    const conversionRatePrevious =
      leadsPrevious > 0 ? Math.round((prevSalesCount / leadsPrevious) * 1000) / 10 : 0;

    const spend = Number(adSpendRow?.spend ?? 0);
    const adRevenue = Number(adSpendRow?.revenue ?? 0);
    const roas = spend > 0 ? Math.round((adRevenue / spend) * 10) / 10 : 0;

    const data = {
      rangeLabel: days === 1 ? "Today" : `${days} Days`,
      days,
      revenue: { current: revenueCurrent, previous: revenuePrevTotal },
      newSales: { count: salesCount, value: revenueCurrent },
      aov: { current: salesCount > 0 ? Math.round(revenueCurrent / salesCount) : 0 },
      leads: { current: leadsCurrent, previous: leadsPrevious },
      eventRegs: {
        webinar: Number(regsRow?.webinar ?? 0),
        challenge: Number(regsRow?.challenge ?? 0),
        total: Number(regsRow?.total ?? 0),
        previous: regsPrevTotal,
      },
      conversionRate: { current: conversionRateCurrent, previous: conversionRatePrevious },
      // Not yet backed by real per-segment data — extend the `clients` table
      // (or similar) and replace these zeros once you're tracking it.
      activeClients: {
        dfy: { count: 0, capacity: 0, label: "Done For You" },
        workshop: { count: 0, label: "Workshop" },
        challenge: { count: 0, label: "VIP Challenge" },
        book: { count: 0, label: "Book Buyers" },
      },
      referrals: { current: referralsCurrent, previous: referralsPrevious },
      adSpend: { spend, revenue: adRevenue, roas },
      alerts: [] as Array<{ type: string; message: string; area: string }>,
      // Channel/funnel/offer breakdowns are placeholders until you add
      // per-channel tracking (e.g. a `channel` column on `leads`/`sales`).
      promote: { channels: [] as unknown[] },
      profit: {
        funnels: [] as unknown[],
        aiSales: {
          ticketsSold: 0,
          assists: 0,
          directSales: 0,
          totalConversations: 0,
          responseTime: "—",
          revenue: 0,
        },
      },
      produce: { offers: [] as unknown[], totalReferrals: referralsCurrent },
    };

    return NextResponse.json(data);
  } catch (err) {
    console.error("[api/metrics] Failed to compute metrics:", err);
    return NextResponse.json(
      { error: "Failed to load metrics from database" },
      { status: 500 }
    );
  }
}
