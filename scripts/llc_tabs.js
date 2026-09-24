// LLC_TAB — the only tabs run_month.js may write. LLC Transactions is DEPRECATED.
// New-row target: Expenses/Revenue tabs, 11-column layout (A..K).
export const LLC_TAB_HEADERS = ['Date', 'Description', 'Amount', 'Sch C Line', 'Sch C Label',
  'Source', 'Card', 'Review', 'Notes', 'Ref/ID', 'Personal'];

// Map a normalized run_month txn (t) to a new Expenses/Revenue row object.
// amount: positive number; type: 'Expense' | 'Profit' | 'COGS'
export function llcRowFromTxn(t, { desc, scline, sclabel, review }) {
  const iso = typeof t.date === 'string' ? t.date
    : new Date(Date.UTC(1899, 11, 30) + Number(t.date) * 86400000).toISOString().slice(0, 10);
  return {
    date: iso,
    desc,
    amount: Number(t.amount),
    scline: String(scline ?? ''),
    sclabel: String(sclabel ?? ''),
    source: t.source === 'plaid' ? (/chase/i.test(t.account.institution) ? 'Chase' : /citi/i.test(t.account.institution) ? 'Citi' : t.account.institution) : 'Manual',
    card: t.account?.labels?.llc ?? '',
    review: review ? 'Y' : '',
    notes: '',
    id: t.raw?.transaction_id ? `plaid:${t.raw.transaction_id}` : '',
    personal: false,
  };
}
