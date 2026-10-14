import Shell from '@/components/Shell';

export default async function WikiPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const path = slug.map((s) => decodeURIComponent(s)).join('/');
  return <Shell path={path} />;
}
