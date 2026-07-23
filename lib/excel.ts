// Excel export (spec §9) — exceljs workbook builder.
import ExcelJS from "exceljs";
import { formatInTimeZone } from "date-fns-tz";
import type { Filters, ListRow, Tab } from "./queries";
import { severityOf } from "./definitions";
import { IST } from "./definitions";

const SEV_FILL: Record<string, { bg: string; fg: string }> = {
  "1-2": { bg: "FFFEF3C7", fg: "FF92400E" },
  "3-5": { bg: "FFFFEDD5", fg: "FF9A3412" },
  "6-10": { bg: "FFFEE2E2", fg: "FFB91C1C" },
  "10+": { bg: "FF991B1B", fg: "FFFFFFFF" },
};

const HEADER_BG = "FF18212E";

type Col = { header: string; width: number; kind?: "date" | "money" | "days" | "int" };

const TAT_COLS: Col[] = [
  { header: "Sr", width: 6, kind: "int" },
  { header: "Order No", width: 16 },
  { header: "AWB", width: 18 },
  { header: "Order Date", width: 13, kind: "date" },
  { header: "Dispatched At", width: 14, kind: "date" },
  { header: "EDD", width: 13, kind: "date" },
  { header: "Days Past EDD", width: 14, kind: "days" },
  { header: "Status", width: 14 },
  { header: "Courier Status", width: 16 },
  { header: "Courier", width: 14 },
  { header: "Shipping Method", width: 24 },
  { header: "Customer", width: 20 },
  { header: "Contact", width: 13 },
  { header: "City", width: 15 },
  { header: "State", width: 15 },
  { header: "Pincode", width: 9 },
  { header: "Payment", width: 9 },
  { header: "Order Value", width: 12, kind: "money" },
  { header: "NDR Reason", width: 32 },
  { header: "Attempts", width: 9, kind: "int" },
  { header: "Warehouse", width: 26 },
  { header: "Seller", width: 16 },
];

const NDR_COLS: Col[] = [
  { header: "Sr", width: 6, kind: "int" },
  { header: "Order No", width: 16 },
  { header: "AWB", width: 18 },
  { header: "Order Date", width: 13, kind: "date" },
  { header: "NDR Reason", width: 36 },
  { header: "Attempts", width: 9, kind: "int" },
  { header: "Days Since Last Update", width: 20, kind: "int" },
  { header: "EDD", width: 13, kind: "date" },
  { header: "Days Past EDD", width: 14, kind: "days" },
  { header: "Courier", width: 14 },
  { header: "Courier Status", width: 16 },
  { header: "Customer", width: 20 },
  { header: "Contact", width: 13 },
  { header: "City", width: 15 },
  { header: "State", width: 15 },
  { header: "Pincode", width: 9 },
  { header: "Payment", width: 9 },
  { header: "Order Value", width: 12, kind: "money" },
  { header: "Warehouse", width: 26 },
  { header: "Seller", width: 16 },
];

function excelDate(d: string | null): Date | null {
  if (!d) return null;
  const [y, m, day] = d.slice(0, 10).split("-").map(Number);
  if (!y || !m || !day) return null;
  return new Date(Date.UTC(y, m - 1, day));
}

function tatValues(r: ListRow, sr: number): unknown[] {
  return [
    sr, r.order_no, r.awb, excelDate(r.order_date), excelDate(r.dispatched_at),
    excelDate(r.edd), r.days_past_edd, r.status, r.courier_live_status ?? "—", r.shipping_company, r.shipping_method,
    r.customer_name, r.customer_contact, r.customer_city, r.customer_state, r.pincode,
    r.payment_type, r.order_total, r.ndr_reason ?? "—", r.attempt_count, r.warehouse, r.seller_name,
  ];
}

function ndrValues(r: ListRow, sr: number): unknown[] {
  return [
    sr, r.order_no, r.awb, excelDate(r.order_date), r.ndr_reason ?? "—", r.attempt_count,
    r.days_since_update, excelDate(r.edd), r.days_past_edd, r.shipping_company, r.courier_live_status ?? "—",
    r.customer_name, r.customer_contact, r.customer_city, r.customer_state, r.pincode,
    r.payment_type, r.order_total, r.warehouse, r.seller_name,
  ];
}

/** Human-readable list of the filters that actually shaped THIS sheet's rows.
 *  The per-tab gating below must mirror buildWhere() in queries.ts exactly — a
 *  label listing a filter the query never applied vouches for the wrong data
 *  (e.g. an unfiltered NDR export headed "Severity=6-10"). */
export function filtersLabel(f: Filters, tab: Tab): string {
  const parts: string[] = [];
  if (f.couriers.length) parts.push(`Courier=${f.couriers.join("+")}`);
  if (f.search) parts.push(`Search="${f.search}"`);
  if (f.payment) parts.push(`Payment=${f.payment}`);
  if (f.state) parts.push(`State=${f.state}`);
  if (f.status && tab === "tat") parts.push(`Status=${f.status}`);
  if (f.pincode) parts.push(`Pincode=${f.pincode}`);
  if (f.dateFrom || f.dateTo) parts.push(`OrderDate=${f.dateFrom ?? "…"}→${f.dateTo ?? "…"}`);
  if (f.severity && tab === "tat") parts.push(`Severity=${f.severity}`);
  if (f.reason && tab === "ndr") parts.push(`Reason=${f.reason}`);
  if (f.minAttempts && f.minAttempts > 0 && tab === "ndr") parts.push(`MinAttempts=${f.minAttempts}`);
  return parts.length ? parts.join(", ") : "none";
}

function addSheet(wb: ExcelJS.Workbook, name: string, cols: Col[], rows: ListRow[], infoText: string) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 2 }] });
  ws.columns = cols.map((c) => ({ width: c.width }));

  // Info row above the header
  const info = ws.getRow(1);
  info.getCell(1).value = infoText;
  info.getCell(1).font = { italic: true, size: 10, color: { argb: "FF5B6B7C" } };
  ws.mergeCells(1, 1, 1, cols.length);

  // Header row — bold white on dark
  const header = ws.getRow(2);
  cols.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_BG } };
    cell.alignment = { vertical: "middle" };
  });
  header.height = 20;
  ws.autoFilter = {
    from: { row: 2, column: 1 },
    to: { row: 2, column: cols.length },
  };

  const mkValues = name === "TAT Breach" ? tatValues : ndrValues;
  rows.forEach((r, idx) => {
    const row = ws.getRow(idx + 3);
    const values = mkValues(r, idx + 1);
    values.forEach((v, i) => {
      const cell = row.getCell(i + 1);
      cell.value = (v as ExcelJS.CellValue) ?? "";
      const kind = cols[i].kind;
      if (kind === "date") cell.numFmt = "dd-mm-yyyy";
      if (kind === "money") cell.numFmt = '"₹" #,##0';
      if (kind === "days" && typeof v === "number") {
        const sev = severityOf(v);
        if (sev) {
          const { bg, fg } = SEV_FILL[sev];
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
          cell.font = { bold: true, color: { argb: fg } };
        }
      }
    });
  });
}

export async function buildWorkbook(
  scope: "both" | "tat" | "ndr",
  data: { tat?: ListRow[]; ndr?: ListRow[] },
  f: Filters
): Promise<{ buffer: ArrayBuffer; filename: string }> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ShipWatch";
  const now = new Date();
  const stampHuman = formatInTimeZone(now, IST, "dd-MMM-yyyy HH:mm");
  const stampFile = formatInTimeZone(now, IST, "yyyy-MM-dd");

  // Each sheet is labelled with its own tab (never "both") — the TAT sheet's
  // rows are shaped by the TAT filters, the NDR sheet's by the NDR ones.
  if (scope === "both" || scope === "tat") {
    addSheet(wb, "TAT Breach", TAT_COLS, data.tat ?? [],
      `Generated ${stampHuman} IST · Filters: ${filtersLabel(f, "tat")}`);
  }
  if (scope === "both" || scope === "ndr") {
    addSheet(wb, "NDR Orders", NDR_COLS, data.ndr ?? [],
      `Generated ${stampHuman} IST · Filters: ${filtersLabel(f, "ndr")}`);
  }

  const filename =
    scope === "both"
      ? `ShipWatch_TAT+NDR_${stampFile}.xlsx`
      : scope === "tat"
        ? `ShipWatch_TAT_Breach_${stampFile}.xlsx`
        : `ShipWatch_NDR_${stampFile}.xlsx`;

  const buffer = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  return { buffer, filename };
}
