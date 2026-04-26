import * as deepl from 'deepl-node';

const deeplClient = new deepl.DeepLClient(import.meta.env.DEEPL_KEY);

export async function translate(text: string, target: "ja" | "en-GB"): Promise<string> {
  const result = await deeplClient.translateText(text, null, target);
  return result.text;
}
