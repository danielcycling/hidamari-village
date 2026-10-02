const GRAM = 6;
const PUNCT = /[\s、。！？!?「」『』（）()・…ー〜：:,.]/;

/**
 * 最近の文章の多くに繰り返し出てくる言い回し（口癖になった話題）を見つける。
 * 6文字のかたまりが何件の文章に出るかを数え、いちばん広がっているものを左右に伸ばす。
 */
export function repeatedTopic(texts: string[], minCount = 3, minShare = 0.4): { phrase: string; count: number } | null {
  if (texts.length < minCount) return null;
  const df = (gram: string) => texts.reduce((n, t) => n + (t.includes(gram) ? 1 : 0), 0);
  const counts = new Map<string, number>();
  for (const t of texts) {
    const seen = new Set<string>();
    for (let i = 0; i + GRAM <= t.length; i++) {
      const g = t.slice(i, i + GRAM);
      if (!PUNCT.test(g)) seen.add(g);
    }
    for (const g of seen) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [g, n] of counts) if (n > bestCount) [best, bestCount] = [g, n];
  if (bestCount < minCount || bestCount < texts.length * minShare) return null;

  // 同じ件数のまま伸ばせるところまで伸ばす
  let phrase = best;
  const host = texts.find((t) => t.includes(best))!;
  let start = host.indexOf(best);
  let end = start + best.length;
  while (start > 0 && !PUNCT.test(host[start - 1]) && df(host.slice(start - 1, end)) === bestCount) start--;
  while (end < host.length && !PUNCT.test(host[end]) && df(host.slice(start, end + 1)) === bestCount) end++;
  phrase = host.slice(start, end);
  return { phrase, count: bestCount };
}

/** 口癖になった話題があれば、本人に気づかせる一文（なければ空） */
export function topicNotice(texts: string[]): string {
  const t = repeatedTopic(texts);
  if (!t) return '';
  return `最近、「${t.phrase}」の話ばかりしている（最近の記憶${texts.length}件のうち${t.count}件）。同じ話を繰り返すだけでは、暮らしは何も変わらない。`;
}
