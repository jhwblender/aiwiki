import type { Metadata } from 'next';
import HistoryView from '@/components/HistoryView';

export const metadata: Metadata = { title: 'Approval history' };

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const sp = await searchParams;
  return <HistoryView page={sp.page} />;
}