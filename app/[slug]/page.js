import { notFound, redirect } from 'next/navigation';

const MAP = {
  parties: '/political-parties-comparison.html',
  constituencies: '/constituencies.html',
  demonetisation: '/demonetisation.html',
  accountability: '/accountability.html',
  corruption: '/corruption-tracker.html',
  bonds: '/electoral-bonds.html',
  mlas: '/mla-criminal-records.html',
  assets: '/asset-growth.html',
  methodology: '/methodology.html',
};

export default function Page({ params }) {
  const dest = MAP[params.slug];
  if (!dest) notFound();
  redirect(dest);
}
