import { describe, expect, it } from "vitest";
import { parseCoverInput } from "./ui";

describe("parseCoverInput (Edit details cover link)", () => {
  it("accepts http and https image links, trimmed", () => {
    expect(parseCoverInput("  https://is1.example.com/600x600bb.jpg ")).toBe("https://is1.example.com/600x600bb.jpg");
    expect(parseCoverInput("http://localhost:3000/c.png")).toBe("http://localhost:3000/c.png");
  });
  it("rejects anything that is not an http(s) URL", () => {
    expect(parseCoverInput("")).toBeNull();
    expect(parseCoverInput("cover.jpg")).toBeNull();
    expect(parseCoverInput("javascript:alert(1)")).toBeNull();
    expect(parseCoverInput("data:image/png;base64,AAAA")).toBeNull();
    expect(parseCoverInput("ftp://example.com/c.jpg")).toBeNull();
  });
});
