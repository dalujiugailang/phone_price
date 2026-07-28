import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const outputDir = path.dirname(fileURLToPath(import.meta.url));
const originalPath = path.resolve(outputDir, "../../data/新机售价监控.xlsx");
const supplementPath = "/Users/dudu/Downloads/新机价格监控--数据源补充.xlsx";

async function loadWorkbook(filePath) {
  return SpreadsheetFile.importXlsx(await FileBlob.load(filePath));
}

async function inspectWorkbook(label, workbook) {
  const sheets = await workbook.inspect({
    kind: "workbook,sheet,table,region",
    maxChars: 12000,
    tableMaxRows: 12,
    tableMaxCols: 24,
    tableMaxCellChars: 120,
  });
  console.log(`--- ${label} ---`);
  console.log(sheets.ndjson);

  const sheet = workbook.worksheets.getItemAt(0);
  const used = sheet.getUsedRange();
  console.log(
    JSON.stringify({
      label,
      firstSheet: sheet.name,
      usedAddress: used?.address ?? null,
      rowCount: used?.rowCount ?? null,
      columnCount: used?.columnCount ?? null,
    }),
  );

  const preview = await workbook.render({
    sheetName: sheet.name,
    range: "A1:Z24",
    scale: 1.5,
    format: "png",
  });
  await fs.writeFile(
    path.join(outputDir, `${label}-preview.png`),
    new Uint8Array(await preview.arrayBuffer()),
  );
}

const original = await loadWorkbook(originalPath);
const supplement = await loadWorkbook(supplementPath);
await inspectWorkbook("original", original);
await inspectWorkbook("supplement", supplement);

function normalize(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function makeKey(model, storage) {
  return `${normalize(model)}\u0000${normalize(storage).toUpperCase()}`;
}

function columnName(index) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function analyzeSheet(label, sheet, modelColumn, storageColumn, dateStartColumn) {
  const used = sheet.getUsedRange();
  const values = used.values;
  const formulas = used.formulas;
  const headerGroups = [];
  for (let column = dateStartColumn; column < used.columnCount; column += 3) {
    headerGroups.push({
      index: column,
      column: columnName(column),
      group: values[1]?.[column] ?? null,
      headers: values[2]?.slice(column, column + 3) ?? [],
      formulas: formulas[3]?.slice(column, column + 3) ?? [],
    });
  }

  const keyRows = new Map();
  const duplicates = [];
  for (let row = 3; row < used.rowCount; row += 1) {
    const key = makeKey(values[row]?.[modelColumn], values[row]?.[storageColumn]);
    if (key === "\u0000") continue;
    if (keyRows.has(key)) duplicates.push({ key, firstRow: keyRows.get(key) + 1, row: row + 1 });
    else keyRows.set(key, row);
  }

  console.log(
    JSON.stringify({
      label,
      headerGroups,
      keyCount: keyRows.size,
      duplicates: duplicates.slice(0, 20),
      duplicateCount: duplicates.length,
    }),
  );
  return { values, formulas, headerGroups, keyRows, duplicates };
}

const originalAnalysis = analyzeSheet("original", original.worksheets.getItemAt(0), 0, 2, 12);
const supplementAnalysis = analyzeSheet("supplement", supplement.worksheets.getItemAt(0), 0, 1, 2);
const originalGroups = new Set(originalAnalysis.headerGroups.map((item) => normalize(item.group)));
const ignoredGroups = new Set(["-7.27原始数据"]);
const newGroups = supplementAnalysis.headerGroups.filter(
  (item) => !originalGroups.has(normalize(item.group)) && !ignoredGroups.has(normalize(item.group)),
);
const missingInOriginal = [];
for (const [key, row] of supplementAnalysis.keyRows) {
  if (!originalAnalysis.keyRows.has(key)) {
    missingInOriginal.push({
      row: row + 1,
      model: supplementAnalysis.values[row][0],
      storage: supplementAnalysis.values[row][1],
    });
  }
}
const missingInSupplement = [];
for (const [key, row] of originalAnalysis.keyRows) {
  if (!supplementAnalysis.keyRows.has(key)) {
    missingInSupplement.push({
      row: row + 1,
      model: originalAnalysis.values[row][0],
      storage: originalAnalysis.values[row][2],
    });
  }
}
console.log(
  JSON.stringify({
    newGroups,
    missingInOriginalCount: missingInOriginal.length,
    missingInOriginal: missingInOriginal.slice(0, 30),
    missingInSupplementCount: missingInSupplement.length,
    missingInSupplement: missingInSupplement.slice(0, 30),
  }),
);

if (process.argv.includes("--merge")) {
  if (originalAnalysis.duplicates.length || supplementAnalysis.duplicates.length) {
    throw new Error("型号名称 + 存储版本存在重复，已停止合并。");
  }
  if (missingInOriginal.length || missingInSupplement.length) {
    throw new Error("两份工作簿的型号名称 + 存储版本集合不一致，已停止合并。");
  }
  if (!newGroups.length) {
    throw new Error("补充文件中没有原表缺少的新日期。");
  }

  const targetSheet = original.worksheets.getItemAt(0);
  const templateRange = targetSheet.getRange(`CV1:CX${targetSheet.getUsedRange().rowCount}`);
  const outputValues = originalAnalysis.values;
  const firstTargetColumn = targetSheet.getUsedRange().columnCount;
  let populatedCells = 0;

  newGroups.forEach((group, groupOffset) => {
    const targetColumn = firstTargetColumn + groupOffset * 3;
    const targetAddress = `${columnName(targetColumn)}1:${columnName(targetColumn + 2)}${outputValues.length}`;
    const targetRange = targetSheet.getRange(targetAddress);
    targetRange.copyFrom(templateRange, "all");

    const blockValues = Array.from({ length: outputValues.length }, () => [null, null, null]);
    blockValues[1] = supplementAnalysis.values[1].slice(group.index, group.index + 3);
    blockValues[2] = supplementAnalysis.values[2].slice(group.index, group.index + 3);
    for (let originalRow = 3; originalRow < outputValues.length; originalRow += 1) {
      const key = makeKey(outputValues[originalRow][0], outputValues[originalRow][2]);
      const supplementRow = supplementAnalysis.keyRows.get(key);
      const rowValues = supplementAnalysis.values[supplementRow].slice(group.index, group.index + 3);
      blockValues[originalRow] = rowValues;
      populatedCells += rowValues.filter((value) => value !== null && value !== "").length;
    }
    targetRange.values = blockValues;
    targetSheet.mergeCells(`${columnName(targetColumn)}2:${columnName(targetColumn + 2)}2`);
  });

  const finalPath = path.join(outputDir, "新机售价监控_已补充至0720.xlsx");
  const exported = await SpreadsheetFile.exportXlsx(original);
  await exported.save(finalPath);

  const finalColumn = firstTargetColumn + newGroups.length * 3 - 1;
  const finalRange = `${columnName(firstTargetColumn)}1:${columnName(finalColumn)}24`;
  const finalPreview = await original.render({
    sheetName: targetSheet.name,
    range: finalRange,
    scale: 1.5,
    format: "png",
  });
  await fs.writeFile(
    path.join(outputDir, "merged-preview.png"),
    new Uint8Array(await finalPreview.arrayBuffer()),
  );
  const secondarySheet = original.worksheets.getItemAt(1);
  if (secondarySheet) {
    const secondaryPreview = await original.render({
      sheetName: secondarySheet.name,
      autoCrop: "all",
      scale: 1.5,
      format: "png",
    });
    await fs.writeFile(
      path.join(outputDir, "secondary-sheet-preview.png"),
      new Uint8Array(await secondaryPreview.arrayBuffer()),
    );
  }

  const check = await original.inspect({
    kind: "table",
    range: `${targetSheet.name}!${columnName(firstTargetColumn)}1:${columnName(finalColumn)}12`,
    include: "values,formulas",
    tableMaxRows: 12,
    tableMaxCols: 39,
    maxChars: 16000,
  });
  console.log(check.ndjson);

  const formulaErrors = await original.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 100 },
    summary: "new-date formula error scan",
  });
  console.log(formulaErrors.ndjson);
  console.log(
    JSON.stringify({
      finalPath,
      newDateCount: newGroups.length,
      matchedRows: originalAnalysis.keyRows.size,
      populatedCells,
      appendedRange: `${columnName(firstTargetColumn)}:${columnName(finalColumn)}`,
      latestGroup: newGroups.at(-1).group,
    }),
  );
}
