import { useRouter } from 'next/router';
import TagView from '../../components/TagView';

// Short path form: /t/<huid>/<weight>/<purity>/<sig>[/<centre code>]
// Much shorter than the query string, so the printed QR has fewer/larger
// modules and scans reliably on the narrow thermal tag.
export default function TagPathPage() {
  const router = useRouter();
  const parts = router.query.q || [];
  const [h, w, p, s, c] = parts;
  return <TagView q={{ h, w, p, s, c }} isReady={router.isReady} />;
}
