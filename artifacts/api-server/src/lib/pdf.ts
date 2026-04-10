import PdfParse from "pdf-parse-new";

interface PdfResult {
  success: boolean;
  text: string;
  error: string;
}

export async function extractTextFromPdf(buffer: Buffer): Promise<PdfResult> {
  try {
    const result = await PdfParse(buffer);

    const text = result.text || "";

    if (text.trim().length === 0) {
      return {
        success: false,
        text: "",
        error: "PDF contains no extractable text. Scanned/image-only PDFs are not supported.",
      };
    }

    return {
      success: true,
      text,
      error: "",
    };
  } catch {
    return {
      success: false,
      text: "",
      error: "Failed to parse PDF file. The file may be corrupted or password-protected.",
    };
  }
}
