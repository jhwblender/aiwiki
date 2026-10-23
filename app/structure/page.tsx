import { redirect } from 'next/navigation';

// The structure is the home page's table of contents now
export default function StructurePage() {
  redirect('/wiki/index#contents');
}
