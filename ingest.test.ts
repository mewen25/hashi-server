import { test, expect } from "bun:test";
import { parseYoutubeId, parseTimedText, htmlToText } from "./ingest";

test("parseYoutubeId handles common YouTube URL shapes", () => {
  const id = "dQw4w9WgXcQ";
  expect(parseYoutubeId(`https://www.youtube.com/watch?v=${id}`)).toBe(id);
  expect(parseYoutubeId(`https://youtube.com/watch?v=${id}&t=42s`)).toBe(id);
  expect(parseYoutubeId(`https://youtu.be/${id}`)).toBe(id);
  expect(parseYoutubeId(`https://www.youtube.com/shorts/${id}`)).toBe(id);
  expect(parseYoutubeId(`https://www.youtube.com/embed/${id}`)).toBe(id);
  expect(parseYoutubeId(`https://m.youtube.com/watch?v=${id}`)).toBe(id);
});

test("parseYoutubeId rejects non-YouTube and malformed urls", () => {
  expect(parseYoutubeId("https://example.com/article")).toBeNull();
  expect(parseYoutubeId("https://www.youtube.com/watch?v=tooshort")).toBeNull();
  expect(parseYoutubeId("not a url")).toBeNull();
});

test("parseTimedText flattens cues and decodes entities", () => {
  const xml =
    '<?xml version="1.0"?><timedtext format="3"><body>' +
    '<p t="0" d="1000">We&#39;re no strangers</p>' +
    '<p t="1000" d="1000"><s>こんにちは</s><s> 世界</s></p>' +
    '<p t="2000" d="1000">   </p>' +
    "</body></timedtext>";
  expect(parseTimedText(xml)).toBe("We're no strangers\nこんにちは 世界");
});

test("htmlToText keeps paragraph breaks and strips tags", () => {
  const html = "<div><p>First para &amp; more.</p><p>Second para.</p><ul><li>one</li><li>two</li></ul></div>";
  const text = htmlToText(html);
  expect(text).toContain("First para & more.");
  expect(text).toContain("Second para.");
  expect(text).toContain("• one");
  expect(text).not.toContain("<");
  expect(text).not.toContain("&amp;");
});
