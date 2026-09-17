import { useRouter } from 'next/router';
import TagView from '../../components/TagView';

// Query-string form: /tag?h=..&w=..&p=..&s=.. (kept for older tags).
export default function TagQueryPage() {
  const router = useRouter();
  return <TagView q={router.query} isReady={router.isReady} />;
}
