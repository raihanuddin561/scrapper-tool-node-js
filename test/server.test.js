const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const {
  extractEmails,
  extractXlsxUrls,
  isPublicAddress,
  validateBatchUrls,
  validatePublicUrl,
} = require("../server");

test("extracts unique emails and decodes common HTML entities", () => {
  assert.deepEqual(
    extractEmails("hello@example.com hello@example.com support&#64;example&#46;org"),
    ["hello@example.com", "support@example.org"]
  );
});

test("does not treat malformed addresses as emails", () => {
  assert.deepEqual(extractEmails("name@localhost or @example.com or a..b@example.com"), []);
});

test("allows public IPs and rejects local or reserved IPs", () => {
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2001:4860:4860::8888"), true);
  assert.equal(isPublicAddress("127.0.0.1"), false);
  assert.equal(isPublicAddress("192.168.1.1"), false);
  assert.equal(isPublicAddress("::1"), false);
  assert.equal(isPublicAddress("2001:db8::1"), false);
  assert.equal(isPublicAddress("2001:4860:4860::8888"), true);
});

test("rejects local network URLs and unsupported schemes", async () => {
  await assert.rejects(validatePublicUrl("http://127.0.0.1/"), /private network/);
  await assert.rejects(validatePublicUrl("ftp://example.com/"), /HTTP and HTTPS/);
});

test("batch links may use different public website origins", async () => {
  const urls = await validateBatchUrls(["https://8.8.8.8/", "https://1.1.1.1/contact"]);
  assert.equal(urls.length, 2);
  assert.deepEqual(urls.map((url) => url.origin), ["https://8.8.8.8", "https://1.1.1.1"]);
  await assert.rejects(validateBatchUrls(["https://8.8.8.8/", "http://127.0.0.1/"]), /private network/);
  await assert.rejects(validateBatchUrls([]), /between 1 and 50/);
  await assert.rejects(
    validateBatchUrls(Array.from({ length: 51 }, () => "https://8.8.8.8/")),
    /between 1 and 50/
  );
});

test("extracts plain URLs and hyperlinks from XLSX worksheets", async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Links");
  worksheet.getCell("A1").value = "https://8.8.8.8/";
  worksheet.getCell("B1").value = {
    text: "Contact page",
    hyperlink: "https://8.8.8.8/contact",
  };
  worksheet.getCell("A2").value = "https://8.8.8.8/about";
  worksheet.getCell("A3").value = "https://8.8.8.8/";

  const workbookData = await workbook.xlsx.writeBuffer();
  assert.deepEqual(await extractXlsxUrls(Buffer.from(workbookData)), [
    "https://8.8.8.8/",
    "https://8.8.8.8/contact",
    "https://8.8.8.8/about",
  ]);
});

test("rejects invalid or empty XLSX data", async () => {
  await assert.rejects(extractXlsxUrls(Buffer.from("not an xlsx")), /invalid or too large/);
  await assert.rejects(
    extractXlsxUrls(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
    /valid \.xlsx file/
  );
});
