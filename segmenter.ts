interface Morpheme {
  reading: string;
  surface: string;
  dictionary_form: string;
  pos: string;
}

export async function segment(kana: string): Promise<Morpheme[]> {
  const res = await fetch("http://127.0.0.1:7331", {
    method: "POST",
    body: kana,
  });
  return res.json();
}
