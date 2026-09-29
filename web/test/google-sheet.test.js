const test = require("node:test");
const assert = require("node:assert/strict");

const GoogleSheet = require("../services/GoogleSheet");

// In-memory Sheets API fixture for checking that layout migrations and later
// writes agree on column positions without touching a real merchant sheet.
const createSheetFixture = (initialRows, initialColumnCount = 26) => {
    const rows = structuredClone(initialRows);
    const requests = [];
    const sheet = {
        properties: {
            sheetId: 123,
            title: "September 2026",
            gridProperties: { rowCount: 1000, columnCount: initialColumnCount },
        },
        tables: [],
    };
    const parseRange = (range) => {
        const [, startCol, startRow, endCol, endRow] = range.match(/!([A-Z]+)(\d*)?(?::([A-Z]+)(\d*)?)?$/);
        const columnIndex = (letters) => [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
        const firstColumn = columnIndex(startCol);
        const lastColumn = columnIndex(endCol || startCol);
        assert.ok(lastColumn < sheet.properties.gridProperties.columnCount, `Out-of-bounds range: ${range}`);
        return {
            firstColumn,
            lastColumn,
            firstRow: Number(startRow || 1) - 1,
            lastRow: endCol ? Number(endRow || rows.length) - 1 : Number(startRow || rows.length) - 1,
        };
    };
    const write = ({ range, values }) => {
        const { firstRow, firstColumn, lastColumn } = parseRange(range);
        values.forEach((row, offset) => {
            assert.ok(row.length <= lastColumn - firstColumn + 1);
            rows[firstRow + offset] ||= [];
            row.forEach((value, column) => { rows[firstRow + offset][firstColumn + column] = value; });
        });
    };
    const clear = ({ range }) => {
        const { firstRow, lastRow, firstColumn, lastColumn } = parseRange(range);
        for (let row = firstRow; row <= lastRow; row += 1) {
            if (!rows[row]) continue;
            for (let col = firstColumn; col <= lastColumn; col += 1) rows[row][col] = "";
        }
        return { data: {} };
    };
    const sheets = {
        spreadsheets: {
            get: async () => {
                const copy = structuredClone(sheet);
                for (const table of copy.tables || []) for (const column of table.columnProperties || []) if (column.columnIndex === 0) delete column.columnIndex;
                return { data: { sheets: [copy] } };
            },
            batchUpdate: async ({ requestBody }) => {
                requests.push(...requestBody.requests);
                for (const request of requestBody.requests) {
                    if (request.insertDimension?.range.dimension === "ROWS" || request.deleteDimension?.range.dimension === "ROWS") {
                        const range = (request.insertDimension || request.deleteDimension).range;
                        const count = range.endIndex - range.startIndex;
                        const delta = request.insertDimension ? count : -count;
                        if (delta > 0) rows.splice(range.startIndex, 0, ...Array.from({ length: count }, () => []));
                        else rows.splice(range.startIndex, count);
                        sheet.properties.gridProperties.rowCount += delta;
                        for (const item of [...sheet.tables.map((table) => table.range), ...(sheet.merges || [])]) {
                            if ((item.startRowIndex || 0) >= range.startIndex) item.startRowIndex = (item.startRowIndex || 0) + delta;
                            if (item.endRowIndex > range.startIndex) item.endRowIndex += delta;
                        }
                        rows.forEach((row) => row.forEach((value, col) => {
                            if (typeof value === "string" && value.startsWith("=")) row[col] = value.replace(/\b(Z|AA)(\d+)/g, (match, column, number) => Number(number) > range.startIndex ? `${column}${Number(number) + delta}` : match);
                        }));
                        continue;
                    }
                    if (request.insertDimension) {
                        const { startIndex, endIndex } = request.insertDimension.range;
                        assert.equal(request.insertDimension.range.dimension, "COLUMNS");
                        rows.forEach((row) => {
                            while (row.length < startIndex) row.push("");
                            row.splice(startIndex, 0, ...Array(endIndex - startIndex).fill(""));
                        });
                        sheet.properties.gridProperties.columnCount += endIndex - startIndex;
                        sheet.tables.forEach((table) => {
                            table.range.endColumnIndex += endIndex - startIndex;
                            table.columnProperties.forEach((column) => {
                                if (column.columnIndex >= startIndex) column.columnIndex += endIndex - startIndex;
                            });
                        });
                    }
                    if (request.appendDimension) {
                        const key = request.appendDimension.dimension === "ROWS" ? "rowCount" : "columnCount";
                        sheet.properties.gridProperties[key] += request.appendDimension.length;
                    }
                    if (request.unmergeCells) sheet.merges = (sheet.merges || []).filter((range) => JSON.stringify(range) !== JSON.stringify(request.unmergeCells.range));
                    if (request.mergeCells) (sheet.merges ||= []).push(structuredClone(request.mergeCells.range));
                    if (request.updateCells) {
                        const { start: providedStart, range, rows: cellRows = [], fields } = request.updateCells;
                        const start = providedStart || { rowIndex: range.startRowIndex || 0, columnIndex: range.startColumnIndex || 0 };
                        if (range && fields.includes("userEnteredValue")) {
                            for (let row = start.rowIndex; row < range.endRowIndex; row++) {
                                rows[row] ||= [];
                                for (let col = start.columnIndex; col < range.endColumnIndex; col++) rows[row][col] = "";
                            }
                        }
                        cellRows.forEach((row, offset) => {
                            rows[start.rowIndex + offset] ||= [];
                            row.values.forEach((cell, col) => {
                                rows[start.rowIndex + offset][start.columnIndex + col] = cell.userEnteredValue.numberValue ?? cell.userEnteredValue.stringValue;
                            });
                        });
                    }
                    if (request.deleteTable) sheet.tables = sheet.tables.filter((table) => table.tableId !== request.deleteTable.tableId);
                    if (request.addTable) sheet.tables.push({ ...structuredClone(request.addTable.table), tableId: `table-${sheet.tables.length + 1}` });
                    if (request.updateTable) {
                        const index = sheet.tables.findIndex((table) => table.tableId === request.updateTable.table.tableId);
                        sheet.tables[index] = { ...sheet.tables[index], ...structuredClone(request.updateTable.table) };
                    }
                }
                return { data: { replies: [] } };
            },
            values: {
                get: async ({ range }) => {
                    const { firstRow, lastRow, firstColumn, lastColumn } = parseRange(range);
                    return { data: { values: rows.slice(firstRow, lastRow + 1).map((row) => row.slice(firstColumn, lastColumn + 1)) } };
                },
                update: async (request) => {
                    write({ range: request.range, values: request.requestBody.values });
                    return { data: { updatedRange: request.range } };
                },
                batchUpdate: async ({ requestBody }) => {
                    requestBody.data.forEach(write);
                    return { data: {} };
                },
                clear: async (request) => clear(request),
                batchClear: async ({ requestBody }) => { requestBody.ranges.forEach((range) => clear({ range })); },
            },
        },
    };
    return { sheets, rows, requests, sheet };
};

test("reorder then refund updates only the original row and preserves every pending row", async () => {
    const originalModels = global.Models;
    const merchant = { _id: "000000000000000000000099" };
    const make = (id, month) => ({ _id: String(id).padStart(24, "0"), merchant: merchant._id, order_name: `TEST-${id}`, status: "APPROVED", createdAt: `2026-${month}-10T12:00:00Z`, google_sheet_sync_enabled: true });
    const pending = [make(1, "08"), make(2, "08")];
    const main = make(3, "09");
    const records = [...pending, main];
    global.Models = { Claim: { find: () => { const q = { lean: async () => records, select: () => q }; return q; } } };
    const fixture = createSheetFixture([GoogleSheet.getStyledSheetHeaders(), GoogleSheet.mapClaimToStyledRow(main)], 40);
    const target = { sheets: fixture.sheets, spreadsheetId: "reorder-refund-safety", sheetTab: "September 2026" };
    try {
        await GoogleSheet.syncPendingClaimsToTarget(merchant, target);
        const before = structuredClone(fixture.rows.slice(1, 3));
        const writes = [];
        for (const [resource, methods] of [[fixture.sheets.spreadsheets.values, ["update", "batchUpdate", "clear", "batchClear"]], [fixture.sheets.spreadsheets, ["batchUpdate"]]]) for (const method of methods) {
            const original = resource[method];
            resource[method] = async (request) => {
                writes.push({ method, request });
                const result = await original(request);
                assert.deepEqual(fixture.rows.slice(1, 3), before, "Pending data changed during a normal claim save");
                return result;
            };
        }
        main.reorder_total = 15;
        await GoogleSheet.syncClaimRowToTarget(main, target, { appendIfMissing: true });
        main.refund_total = 20; main.status = "RESOLVED";
        await GoogleSheet.syncClaimRowToTarget(main, target, { appendIfMissing: true });
        assert.equal(writes.length, 2, "Each existing-claim save should write just its own row");
        assert.ok(writes.every(({ method, request }) => method === "update" && request.range === "'September 2026'!A4:AA4"));
        assert.equal(fixture.rows[3][6], "Refunded/Reordered");
        assert.equal(fixture.rows[3][7], 35);
        assert.equal(fixture.rows.filter(row => row[24] === main._id).length, 1);
    } finally { global.Models = originalModels; }
});

test("recovers a cleared pending row without moving originals or claiming its gap for a new original", async () => {
    const originalModels = global.Models;
    const merchant = { _id: "000000000000000000000099" };
    const make = (id, month) => ({ _id: String(id).padStart(24, "0"), merchant: merchant._id, order_name: `TEST-${id}`, status: "REVIEWING", createdAt: `2026-${month}-10T12:00:00Z`, google_sheet_sync_enabled: true });
    const pending = [make(1, "08"), make(2, "08")];
    const main = make(3, "09");
    const records = [...pending, main];
    global.Models = { Claim: { find: () => { const q = { lean: async () => records, select: () => q }; return q; } } };
    const fixture = createSheetFixture([GoogleSheet.getStyledSheetHeaders(), GoogleSheet.mapClaimToStyledRow(main)], 40);
    const target = { sheets: fixture.sheets, spreadsheetId: "pending-gap", sheetTab: "September 2026" };
    try {
        await GoogleSheet.syncPendingClaimsToTarget(merchant, target);
        const firstPending = structuredClone(fixture.rows[1]);
        fixture.rows[1] = ["", "Claim / Order Number", "", "m/d/yyyy", "", "", "", "$xx", "Notes", "m/d/yyyy"];
        // Both the normal append and missing-original recovery paths must leave
        // the empty carryover slot available for its original pending claim.
        const restored = make(4, "09"); const added = make(5, "09");
        records.push(restored, added);
        await GoogleSheet.syncClaimRowToTarget(added, target, { appendIfMissing: true });
        assert.equal(fixture.rows[1][1], "Claim / Order Number");
        assert.equal(fixture.rows[3][24], main._id);
        const before = structuredClone(fixture.rows.slice(3));
        await GoogleSheet.syncPendingClaimsToTarget(merchant, target);
        assert.deepEqual(fixture.rows[1], firstPending);
        assert.deepEqual(fixture.rows.slice(3), before);
        await GoogleSheet.syncPendingClaimsToTarget(merchant, target);
        assert.deepEqual(fixture.rows.slice(3), before);
        fixture.rows[1] = ["Do not overwrite this manual row"];
        const unsafe = structuredClone(fixture.rows);
        await assert.rejects(GoogleSheet.syncPendingClaimsToTarget(merchant, target), /outside their leading block/);
        assert.deepEqual(fixture.rows, unsafe);
    } finally { global.Models = originalModels; }
});

test("mixed-layout repair keeps originals in place below pending and manual rows", async () => {
    const originalModels = global.Models;
    const claim = { _id: "000000000000000000000003", status: "RESOLVED", order_name: "TEST-3", refund_total: 20, reorder_total: 15 };
    const pending = Array(27).fill(""); pending[1] = "TEST-1"; pending[24] = "pending:000000000000000000000001";
    const fixture = createSheetFixture([GoogleSheet.getStyledSheetHeaders(), pending, ["Keep this manual row"], GoogleSheet.mapClaimToStyledRow(claim)], 40);
    global.Models = { Claim: { find: () => ({ lean: async () => [claim] }) } };
    try {
        const before = structuredClone(fixture.rows.slice(0, 3));
        await GoogleSheet.repairMixedStyledClaimRows({ sheets: fixture.sheets, spreadsheetId: "mixed-pending", sheetTab: "September 2026", dataStartRow: 2 });
        assert.deepEqual(fixture.rows.slice(0, 3), before);
        assert.equal(fixture.rows[3][24], claim._id);
    } finally { global.Models = originalModels; }
});

test("migrates an existing sheet once, preserving row data and restoring separate statuses", async () => {
    const originalModels = global.Models;
    const claimId = "6a96aea587520e3a8da59725";
    const oldHeaders = GoogleSheet.getStyledSheetHeaders();
    oldHeaders.splice(6, 1);
    const oldRow = ["8/28/2026", "2812", "Refunded/Reordered", "9/1/2026", "Store", "customer@example.com", 65, "Keep my edited note", "9/2/2026", ...Array(14).fill(""), claimId, 25, 40];
    const fixture = createSheetFixture([oldHeaders, oldRow]);
    const oldTable = GoogleSheet.buildStyledTableDefinition({ sheetId: 123, headerRowIndex: 0, lastClaimRow: 2 });
    oldTable.tableId = "existing-table";
    oldTable.range.endColumnIndex = 9;
    oldTable.columnProperties.splice(6, 1);
    oldTable.columnProperties.forEach((column, index) => { column.columnIndex = index; });
    fixture.sheet.tables.push(oldTable);
    global.Models = {
        ...(originalModels || {}),
        Claim: { find: () => { const query = { lean: async () => [{ _id: claimId, status: "RESOLVED", refund_total: "25", reorder_total: "40" }] }; query.select = () => query; return query; } },
    };
    try {
        const layout = await GoogleSheet.ensureSheetLayout({ sheets: fixture.sheets, spreadsheetId: "migration-test", sheetTab: "September 2026" });
        assert.equal(layout.internalIdColumn, "Y");
        assert.equal(layout.internalIdIndex, 24);
        assert.equal(layout.endColumn, "AA");
        assert.deepEqual(fixture.rows[0], GoogleSheet.getStyledSheetHeaders());
        const expected = [...oldRow];
        expected.splice(6, 0, "Refunded/Reordered");
        expected[2] = "Resolved";
        assert.deepEqual(fixture.rows[1], expected);
        assert.equal(fixture.rows[11][6], undefined);
        assert.equal(fixture.rows[11][7], "$xx");
        assert.equal(fixture.rows[11][8], "Notes");
        assert.equal(fixture.rows[11][9], "m/d/yyyy");
        assert.equal(fixture.rows[47][1], "=SUM(Z2:Z)");
        assert.equal(fixture.rows[48][1], "=SUM(AA2:AA)");
        assert.equal(fixture.sheet.tables[0].columnProperties[6].columnType, "TEXT");
        assert.equal(fixture.sheet.tables[0].columnProperties[7].columnType, "CURRENCY");
        assert.ok(fixture.requests.find((request) => request.updateTable)?.updateTable.fields.includes("columnProperties"));
        // A fresh cache key exercises layout detection again after a restart.
        await GoogleSheet.ensureSheetLayout({ sheets: fixture.sheets, spreadsheetId: "migration-test-retry", sheetTab: "September 2026" });
        assert.equal(fixture.requests.filter((request) => request.insertDimension).length, 0);
        assert.equal(fixture.sheet.properties.gridProperties.columnCount, 27);
        assert.deepEqual(fixture.rows[1], expected);
    } finally {
        global.Models = originalModels;
    }
});

test("initializes a new sheet with room for the extra visible column and hidden totals", async () => {
    const fixture = createSheetFixture([]);
    const layout = await GoogleSheet.ensureSheetLayout({ sheets: fixture.sheets, spreadsheetId: "new-layout-test", sheetTab: "September 2026" });
    assert.equal(layout.endColumn, "AA");
    assert.equal(fixture.sheet.properties.gridProperties.columnCount, 27);
    assert.equal(fixture.requests.filter((request) => request.insertDimension).length, 0);
    assert.deepEqual(fixture.rows[0], GoogleSheet.getStyledSheetHeaders());
    assert.equal(fixture.sheet.tables[0].range.endColumnIndex, 10);
});

test("repairs the screenshot's double-shifted rows and duplicates without losing other claims", async () => {
    const originalModels = global.Models;
    const claims = [
        { _id: "6aab9836473b18f22db77596", order_name: "2873", status: "RESOLVED", refund_total: "49.98", reorder_total: "41.99" },
        { _id: "6a96b8cd87520e3a8da61281", order_name: "2809", status: "RESOLVED", refund_total: "72.49" },
    ];
    const canonical = GoogleSheet.mapClaimToStyledRow(claims[0]);
    canonical[8] = "Edited note";
    const shifted = GoogleSheet.mapClaimToStyledRow(claims[1]);
    shifted[8] = "Keep other claim's note";
    shifted.splice(6, 0, "");
    const stale = GoogleSheet.mapClaimToStyledRow({ ...claims[0], status: "APPROVED", reorder_total: "0" });
    stale.splice(6, 0, "");
    const fixture = createSheetFixture([GoogleSheet.getStyledSheetHeaders(), canonical, shifted, stale, ["", "Claim / Order Number", "", "m/d/yyyy", "", "", "", "$xx", "$xx", "Notes", "m/d/yyyy"]], 28);
    global.Models = { ...(originalModels || {}), Claim: { find: () => { const query = { lean: async () => claims }; query.select = () => query; return query; } } };
    try {
        await GoogleSheet.ensureSheetLayout({ sheets: fixture.sheets, spreadsheetId: "double-shift", sheetTab: "September 2026" });
        assert.equal(fixture.rows.filter((row) => row[24] === claims[0]._id).length, 1);
        assert.equal(fixture.rows[1][2], "Resolved");
        assert.equal(fixture.rows[1][6], "Refunded/Reordered");
        assert.equal(fixture.rows[1][7], 91.97);
        assert.equal(fixture.rows[1][8], "Edited note");
        assert.equal(fixture.rows[2][6], "Refunded");
        assert.equal(fixture.rows[2][7], 72.49);
        assert.equal(fixture.rows[2][8], "Keep other claim's note");
        assert.equal(fixture.rows[2][24], claims[1]._id);
        assert.equal(fixture.rows[2][27], "");
        assert.equal(fixture.rows[4][6], "");
        assert.equal(fixture.rows[4][7], "$xx");
        assert.equal(fixture.rows[4][8], "Notes");
        assert.equal(fixture.rows[4][10], "");
        assert.equal(fixture.requests.filter((request) => request.insertDimension).length, 0);
        const before = JSON.stringify(fixture.rows);
        await GoogleSheet.ensureSheetLayout({ sheets: fixture.sheets, spreadsheetId: "double-shift", sheetTab: "September 2026" });
        assert.equal(JSON.stringify(fixture.rows), before);
    } finally { global.Models = originalModels; }
});

test("two independent workers serialize lookup and append, leaving one row per claim", async () => {
    const originalModels = global.Models;
    const claims = [1, 2].map((index) => ({ _id: String(index).padStart(24, "0"), order_name: String(2900 + index), status: "REVIEWING" }));
    const leases = new Map();
    const db = { collection: () => ({
        findOneAndUpdate: async (query, update) => {
            if (leases.has(query._id)) { const error = new Error("duplicate lock"); error.code = 11000; throw error; }
            leases.set(query._id, update.$set);
            return { value: update.$set };
        },
        deleteOne: async (query) => { if (leases.get(query._id)?.owner === query.owner) leases.delete(query._id); },
        updateOne: async () => {},
    }) };
    global.Models = { ...(originalModels || {}), Claim: { db, find: () => { const query = { lean: async () => claims }; query.select = () => query; return query; } } };
    delete require.cache[require.resolve("../services/GoogleSheet")];
    const otherWorker = require("../services/GoogleSheet");
    const fixture = createSheetFixture([]);
    const target = { sheets: fixture.sheets, spreadsheetId: "concurrent-workers", sheetTab: "September 2026" };
    try {
        await Promise.all([
            GoogleSheet.syncClaimRowToTarget(claims[0], target, { appendIfMissing: true }),
            otherWorker.syncClaimRowToTarget(claims[0], target, { appendIfMissing: true }),
            GoogleSheet.syncClaimRowToTarget(claims[1], target, { appendIfMissing: true }),
            otherWorker.syncClaimRowToTarget(claims[1], target, { appendIfMissing: true }),
        ]);
        for (const claim of claims) assert.equal(fixture.rows.filter((row) => row[24] === claim._id).length, 1);
        assert.equal(leases.size, 0);
        assert.equal(fixture.requests.filter((request) => request.insertDimension).length, 0);
    } finally { global.Models = originalModels; }
});

test("normal sync restores an overwritten monthly claim and preserves occupied rows", async () => {
    const originalModels = global.Models;
    const originalLogger = global.Logger;
    const merchant = "699ecac5ba627e480aa4a5a7";
    const active = { _id: "6aab9c82840eb291a63c0249", order_name: "2871", merchant, status: "RESOLVED", refund_total: "200", reorder_total: "286.99", google_sheet_sync_enabled: true, createdAt: "2026-09-17T07:53:38.971Z" };
    const missing = { ...active, _id: "6aab9836473b18f22db77596", order_name: "2873", refund_total: "49.98", reorder_total: "41.99" };
    const disabled = { ...missing, _id: "000000000000000000000003", google_sheet_sync_enabled: false };
    const otherMerchant = { ...missing, _id: "000000000000000000000004", merchant: "another-merchant" };
    const otherMonth = { ...missing, _id: "000000000000000000000005", createdAt: "2026-08-01T00:00:00Z" };
    const records = [active, missing, disabled, otherMerchant, otherMonth];
    const logs = [];
    const fixture = createSheetFixture([GoogleSheet.getStyledSheetHeaders(), ["Keep this occupied row"], GoogleSheet.mapClaimToStyledRow(active)], 27);
    const target = { sheets: fixture.sheets, spreadsheetId: "restore-on-normal-sync", sheetTab: "September 2026" };
    global.Models = { ...(originalModels || {}), Claim: { find: () => { const query = { lean: async () => records }; query.select = () => query; return query; } } };
    global.Logger = { info: (message) => logs.push(message) };
    try {
        await GoogleSheet.syncClaimRowToTarget(active, target, { appendIfMissing: true });
        await GoogleSheet.syncClaimRowToTarget(active, target, { appendIfMissing: true });
        assert.equal(fixture.rows[1][0], "Keep this occupied row");
        const actual = fixture.rows.filter((row) => /^[a-f0-9]{24}$/i.test(row[24] || ""));
        assert.equal(actual.length, 2);
        const restored = actual.find((row) => row[24] === missing._id);
        assert.equal(restored[1], "2873");
        assert.equal(restored[6], "Refunded/Reordered");
        assert.equal(restored[7], 91.97);
        assert.ok(logs.some((message) => message.includes("Verified write") && message.includes(GoogleSheet.syncVersion)));
    } finally {
        global.Models = originalModels;
        global.Logger = originalLogger;
    }
});

test("formats a merchant-specific spreadsheet title", () => {
    assert.equal(
        GoogleSheet.formatSpreadsheetTitle({ name: "Lola" }),
        "Swipe Claims - Lola"
    );
    assert.equal(
        GoogleSheet.formatSpreadsheetTitle({ shop_id: "black-rock.myshopify.com" }),
        "Swipe Claims - black-rock.myshopify.com"
    );
});

test("uses Claims as the default merchant sheet tab", () => {
    assert.equal(GoogleSheet.getMerchantSheetTab({}), "Claims");
    assert.equal(
        GoogleSheet.getMerchantSheetTab({ google_sheet_tab: "Merchant Claims" }),
        "Merchant Claims"
    );
});

test("only new claims may be appended when an update cannot find a row", () => {
    assert.equal(
        GoogleSheet.shouldAppendMissingClaim({
            google_sheet_sync_enabled: true,
        }),
        true
    );
    assert.equal(GoogleSheet.shouldAppendMissingClaim({}), false);
    assert.equal(
        GoogleSheet.shouldAppendMissingClaim({
            google_sheet_sync_enabled: false,
        }),
        false
    );
});

test("merchant Google Sheet sync must be explicitly enabled", () => {
    assert.equal(
        GoogleSheet.isMerchantSheetSyncEnabled({
            google_sheet_claim_sync_enabled: true,
        }),
        true
    );
    assert.equal(GoogleSheet.isMerchantSheetSyncEnabled({}), false);
    assert.equal(
        GoogleSheet.isMerchantSheetSyncEnabled({
            google_sheet_claim_sync_enabled: false,
        }),
        false
    );
});

test("routes claims to tabs using their claim month in the Sheet timezone", () => {
    const originalTimeZone = process.env.GOOGLE_SHEET_TIMEZONE;
    process.env.GOOGLE_SHEET_TIMEZONE = "Asia/Karachi";

    try {
        assert.equal(
            GoogleSheet.getClaimMonthSheetTab({
                createdAt: "2026-08-31T18:30:00.000Z",
                updatedAt: "2026-09-10T00:00:00.000Z",
            }),
            "August 2026"
        );
        assert.equal(
            GoogleSheet.getClaimMonthSheetTab({
                createdAt: "2026-08-31T20:30:00.000Z",
            }),
            "September 2026"
        );
    } finally {
        if (originalTimeZone === undefined) {
            delete process.env.GOOGLE_SHEET_TIMEZONE;
        } else {
            process.env.GOOGLE_SHEET_TIMEZONE = originalTimeZone;
        }
    }
});

test("creates a missing monthly tab at the front of the spreadsheet", async () => {
    const batchUpdates = [];
    const sheets = {
        spreadsheets: {
            get: async () => ({ data: { sheets: [] } }),
            batchUpdate: async (request) => {
                batchUpdates.push(request);
                return {
                    data: {
                        replies: [
                            {
                                addSheet: {
                                    properties: {
                                        sheetId: 123,
                                        title: "September 2026",
                                        index: 0,
                                    },
                                },
                            },
                        ],
                    },
                };
            },
        },
    };

    const properties = await GoogleSheet.ensureSpreadsheetTab({
        sheets,
        spreadsheetId: "sheet-1",
        sheetTab: "September 2026",
    });

    assert.equal(properties.sheetId, 123);
    assert.equal(batchUpdates.length, 1);
    assert.deepEqual(
        batchUpdates[0].requestBody.requests[0].addSheet.properties,
        { title: "September 2026", index: 0 }
    );
});

test("keeps the styled Sheet headers and status dropdown in reference order", () => {
    assert.deepEqual(GoogleSheet.getStyledSheetHeaders().slice(0, 10), [
        "Order Date",
        "Claim / Order Number",
        "Status",
        "Claim Date",
        "Merchant",
        "Customer Email",
        "Refund/Reorder Status",
        "Refund/Replace Amount",
        "Notes",
        "Claim Closed",
    ]);
    assert.deepEqual(GoogleSheet.getStyledStatusOptions(), [
        "In Review",
        "Approved",
        "Resolved",
        "Reject",
    ]);
});

test("builds the native Google Table design with banded rows and typed columns", () => {
    const table = GoogleSheet.buildStyledTableDefinition({
        name: "Table1",
        sheetId: 123,
        headerRowIndex: 0,
        lastClaimRow: 12,
    });

    assert.equal(table.name, "Table1");
    assert.deepEqual(table.range, {
        sheetId: 123,
        startRowIndex: 0,
        endRowIndex: 44,
        startColumnIndex: 0,
        endColumnIndex: 10,
    });
    assert.equal(table.columnProperties[0].columnType, "DATE");
    assert.equal(table.columnProperties[2].columnType, "DROPDOWN");
    assert.equal(table.columnProperties[6].columnType, "TEXT");
    assert.equal(table.columnProperties[7].columnType, "CURRENCY");
    assert.equal(table.columnProperties[8].columnName, "Notes");
    assert.equal(table.columnProperties[9].columnType, "DATE");
    assert.deepEqual(
        table.columnProperties[2].dataValidationRule.condition.values.map(
            (value) => value.userEnteredValue
        ),
        ["In Review", "Approved", "Resolved", "Reject"]
    );
    assert.notDeepEqual(
        table.rowsProperties.firstBandColorStyle,
        table.rowsProperties.secondBandColorStyle
    );
});

test("deletes conditional-format rules from highest index to lowest", () => {
    assert.deepEqual(
        GoogleSheet.buildConditionalFormatDeleteRequests(856939122, [0, 2, 1]),
        [
            {
                deleteConditionalFormatRule: {
                    sheetId: 856939122,
                    index: 2,
                },
            },
            {
                deleteConditionalFormatRule: {
                    sheetId: 856939122,
                    index: 1,
                },
            },
            {
                deleteConditionalFormatRule: {
                    sheetId: 856939122,
                    index: 0,
                },
            },
        ]
    );
});

test("only authorized admins receive merchant Sheet viewer access", () => {
    const merchantId = "merchant-123";

    assert.equal(
        GoogleSheet.canAdminViewMerchantSheet(
            { role: "admin", admin_type: "super_admin" },
            merchantId
        ),
        true
    );
    assert.equal(
        GoogleSheet.canAdminViewMerchantSheet(
            {
                role: "admin",
                admin_type: "simple_admin",
                admin_permissions: { claims_view: true },
                merchants: [merchantId],
            },
            merchantId
        ),
        true
    );
    assert.equal(
        GoogleSheet.canAdminViewMerchantSheet(
            {
                role: "admin",
                admin_type: "simple_admin",
                admin_permissions: { claims_view: true },
                merchants: ["another-merchant"],
            },
            merchantId
        ),
        false
    );
    assert.equal(
        GoogleSheet.canAdminViewMerchantSheet(
            {
                role: "admin",
                admin_type: "simple_admin",
                admin_permissions: { claims_view: false },
                merchants: [merchantId],
            },
            merchantId
        ),
        false
    );
    assert.equal(
        GoogleSheet.canAdminViewMerchantSheet(
            { role: "admin", admin_type: "super_admin", disabled: true },
            merchantId
        ),
        false
    );
});

test("loads Google OAuth configuration from the database", async () => {
    const originalModels = global.Models;
    global.Models = {
        ...(originalModels || {}),
        GoogleSheetConfig: {
            findOne: () => ({
                select: () => ({
                    lean: async () => ({
                        client_id: "database-client-id",
                        client_secret: "database-client-secret",
                        refresh_token: "database-refresh-token",
                    }),
                }),
            }),
        },
    };

    GoogleSheet.resetOAuthClient();
    try {
        assert.equal(await GoogleSheet.isConfigured(), true);
    } finally {
        GoogleSheet.resetOAuthClient();
        global.Models = originalModels;
    }
});

test("maps a closed claim to the existing sheet layout", () => {
    const row = GoogleSheet.mapClaimToRow({
        _id: "claim-123",
        createdAt: "2026-08-25T12:00:00.000Z",
        updatedAt: "2026-08-25T13:00:00.000Z",
        order_name: "#1001",
        order_snapshot: {
            created_at: "2026-08-24T12:00:00.000Z",
            customer_name: "Test Customer",
            customer_email: "customer@example.com",
        },
        merchant_snapshot: { name: "Lola" },
        reason: "Lost",
        description: "Package missing",
        combined_refund_total: "24.99",
        status: "CLOSED",
    });

    assert.equal(row.length, 12);
    assert.equal(row[5], "Lola");
    assert.equal(row[8], "24.99");
    assert.equal(row[9], "REJECT");
    assert.equal(row[10], "claim-123");
    assert.ok(row[11]);
});

test("maps claims to the client Sheet layout with hidden technical data", () => {
    const row = GoogleSheet.mapClaimToStyledRow({
        _id: "claim-456",
        createdAt: "2026-08-25T12:00:00.000Z",
        resolved_date: "2026-08-26T12:00:00.000Z",
        order_name: "#2002",
        order_snapshot: {
            created_at: "2026-08-24T12:00:00.000Z",
            customer_name: "Styled Customer",
            customer_email: "styled@example.com",
        },
        merchant_snapshot: { name: "Styled Merchant" },
        description: "Replacement sent",
        combined_refund_total: "35.50",
        refund_total: "10.00",
        reorder_total: "25.50",
        status: "RESOLVED",
    });

    assert.equal(row.length, 27);
    assert.deepEqual(row.slice(0, 10), [
        "8/24/2026",
        "#2002",
        "Resolved",
        "8/25/2026",
        "Styled Merchant",
        "styled@example.com",
        "Refunded/Reordered",
        35.5,
        "Replacement sent",
        "8/26/2026",
    ]);
    assert.equal(row[24], "claim-456");
    assert.equal(row[25], 10);
    assert.equal(row[26], 25.5);
    assert.ok(row[9]);
});

test("uses the processed amount when stored totals are still zero", () => {
    const row = GoogleSheet.mapClaimToStyledRow({
        _id: "claim-789",
        combined_refund_total: "0",
        swipe_by_refunded: "49.95",
        refund_total: "0.00",
        reorder_total: "0.00",
        refund_status: "REFUND",
        status: "RESOLVED",
    });

    assert.equal(row[2], "Resolved");
    assert.equal(row[6], "Refunded");
    assert.equal(row[7], 49.95);
    assert.equal(row[25], 49.95);
    assert.equal(row[26], 0);
});

test("maps cumulative refund and reorder outcomes without changing amounts or dates", () => {
    for (const status of ["APPROVED", "RESOLVED"]) {
        for (const [refundTotal, reorderTotal, expected] of [
            [25, 0, "Refunded"],
            [0, 40, "Reordered"],
            [25, 40, "Refunded/Reordered"],
        ]) {
            // A preference/last action must not override actual cumulative totals.
            for (const refundStatus of ["REFUND", "REPLACE", "reorder", undefined]) {
                const row = GoogleSheet.mapClaimToStyledRow({
                    status,
                    refund_status: refundStatus,
                    refund_total: String(refundTotal),
                    reorder_total: String(reorderTotal),
                    combined_refund_total: String(refundTotal + reorderTotal),
                    resolved_date: "2026-09-17T00:00:00.000Z",
                });
                assert.equal(row[2], status === "RESOLVED" ? "Resolved" : "Approved");
                assert.equal(row[6], expected);
                assert.equal(row[7], refundTotal + reorderTotal);
                assert.equal(row[9], status === "RESOLVED" ? "9/17/2026" : "");
            }
        }
    }
});

test("supports older reorder totals and does not treat a preference alone as processed", () => {
    for (const refundStatus of ["REPLACE", "REORDER", "reorder"]) {
        const row = GoogleSheet.mapClaimToStyledRow({
            status: "RESOLVED",
            refund_status: refundStatus,
            combined_refund_total: "39.50",
        });
        assert.equal(row[2], "Resolved");
        assert.equal(row[6], "Reordered");
    }
    for (const [status, expected] of [["APPROVED", "Approved"], ["RESOLVED", "Resolved"]]) {
        const row = GoogleSheet.mapClaimToStyledRow({
            status,
            refund_status: "REFUND",
            refund_total: "0.00",
            reorder_total: "0.00",
        });
        assert.equal(row[2], expected);
        assert.equal(row[6], "");
    }
});

test("maps reviewing and in-review claims to the visible Sheet status", () => {
    const reviewingRow = GoogleSheet.mapClaimToStyledRow({
        _id: "claim-reviewing",
        status: "REVIEWING",
        refund_status: "REPLACE",
        claim_total: "50.75",
    });
    const fallbackRow = GoogleSheet.mapClaimToStyledRow({
        _id: "claim-in-review",
        sub_status: "IN_REVIEW",
    });

    assert.equal(reviewingRow[2], "In Review");
    assert.equal(reviewingRow[6], "");
    assert.equal(reviewingRow[25], 0);
    assert.equal(reviewingRow[26], 0);
    assert.equal(fallbackRow[2], "In Review");
});

test("maps rejected and completed claims to their final Sheet statuses", () => {
    const rejectedRow = GoogleSheet.mapClaimToStyledRow({
        _id: "claim-rejected",
        status: "CLOSED",
        refund_status: "REPLACE",
        reorder_total: "25.00",
    });
    const completedRow = GoogleSheet.mapClaimToStyledRow({
        _id: "claim-completed",
        status: "RESOLVED",
    });
    const approvedRow = GoogleSheet.mapClaimToStyledRow({
        _id: "claim-approved",
        status: "APPROVED",
    });

    assert.equal(rejectedRow[2], "Reject");
    assert.equal(rejectedRow[6], "Rejected");
    assert.equal(completedRow[2], "Resolved");
    assert.equal(approvedRow[2], "Approved");
});

test("backfills a blank styled Sheet status from the claim record", async () => {
    const originalModels = global.Models;
    const claimId = "6a96aea587520e3a8da59725";
    const batchUpdates = [];
    global.Models = {
        ...(originalModels || {}),
        Claim: {
            find: () => ({
                select: () => ({
                    lean: async () => [
                        {
                            _id: claimId,
                            status: "REVIEWING",
                            sub_status: "IN_REVIEW",
                        },
                    ],
                }),
            }),
        },
    };

    const sheets = {
        spreadsheets: {
            values: {
                get: async () => ({
                    data: {
                        values: [[...Array(22).fill(""), claimId]],
                    },
                }),
                batchUpdate: async (request) => {
                    batchUpdates.push(request);
                    return { data: {} };
                },
            },
        },
    };

    try {
        const updated = await GoogleSheet.backfillMissingStyledStatuses({
            sheets,
            spreadsheetId: "sheet-1",
            sheetTab: "Claims",
            dataStartRow: 2,
        });

        assert.equal(updated, 1);
        assert.equal(batchUpdates.length, 1);
        assert.equal(
            batchUpdates[0].requestBody.data[0].range,
            "'Claims'!C2"
        );
        assert.deepEqual(batchUpdates[0].requestBody.data[0].values, [
            ["In Review"],
        ]);
    } finally {
        global.Models = originalModels;
    }
});

test("backfills the separate resolution column and restores misplaced lifecycle statuses", async () => {
    const originalModels = global.Models;
    const cases = [
        { status: "RESOLVED", refund_total: "25", current: "Resolved", expected: "Refunded" },
        { status: "CLOSED", current: "Reject", expected: "Rejected" },
        { status: "RESOLVED", reorder_total: "40", current: "Resolved", expected: "Reordered" },
        { status: "APPROVED", refund_total: "25", reorder_total: "40", current: "Approved", expected: "Refunded/Reordered" },
        { status: "RESOLVED", current: "Resolved" },
        { status: "APPROVED", current: "Approved" },
        { status: "RESOLVED", refund_total: "25", current: "Refunded", expected: "Refunded", corrected: "Resolved" },
        { status: "RESOLVED", refund_total: "25", current: "Manual note", expected: "Refunded" },
        { status: "RESOLVED", reorder_total: "40", current: "Reordered", expected: "Reordered", corrected: "Resolved" },
        { status: "APPROVED", refund_total: "25", reorder_total: "40", current: "Refunded/Reordered", expected: "Refunded/Reordered", corrected: "Approved" },
    ].map((claim, index) => ({ ...claim, _id: String(index + 1).padStart(24, "0") }));
    const writes = [];
    global.Models = {
        ...(originalModels || {}),
        Claim: {
            find: (query) => {
                return { select: () => ({ lean: async () => cases }) };
            },
        },
    };
    const sheets = {
        spreadsheets: {
            values: {
                get: async () => ({
                    data: { values: cases.map((claim) => [claim.current, ...Array(21).fill(""), claim._id]) },
                }),
                batchUpdate: async (request) => { writes.push(request); },
            },
        },
    };
    try {
        const updated = await GoogleSheet.backfillMissingStyledStatuses({
            sheets,
            spreadsheetId: "sheet-1",
            sheetTab: "September 2026",
            dataStartRow: 2,
        });
        assert.equal(updated, 11);
        assert.equal(writes.length, 1);
        assert.deepEqual(writes[0].requestBody.data, cases.flatMap((claim, index) => [
            ...(claim.corrected ? [{
                range: `'September 2026'!C${index + 2}`,
                values: [[claim.corrected]],
            }] : []),
            ...(claim.expected ? [{
                range: `'September 2026'!G${index + 2}`,
                values: [[claim.expected]],
            }] : []),
        ]));
    } finally {
        global.Models = originalModels;
    }
});

test("repairs and deduplicates mixed legacy and styled claim rows", async () => {
    const originalModels = global.Models;
    const claimId = "6a96aea587520e3a8da59725";
    const rows = Array.from({ length: 50 }, () => []);
    rows[0] = [
        "8/28/2026",
        "2812",
        "Refunded",
        "9/1/2026",
        "Swipe Test Store",
        "customer@example.com",
        50.75,
        "test 4",
        "9/1/2026",
        claimId,
        50.75,
        0,
    ];
    rows[45] = ["SUMMARY"];
    rows[49] = [
        "8/28/2026",
        "9/1/2026",
        "2812",
        "Customer",
        "customer@example.com",
        "Swipe Test Store",
        "Damaged",
        "test 4",
        50.75,
        "RESOLVED",
        claimId,
        "9/1/2026",
    ];

    global.Models = {
        ...(originalModels || {}),
        Claim: {
            find: () => ({
                lean: async () => [
                    {
                        _id: claimId,
                        createdAt: "2026-09-01T00:00:00.000Z",
                        resolved_date: "2026-09-01T00:00:00.000Z",
                        order_name: "2812",
                        order_snapshot: {
                            created_at: "2026-08-28T00:00:00.000Z",
                            customer_name: "Customer",
                            customer_email: "customer@example.com",
                        },
                        merchant_snapshot: { name: "Swipe Test Store" },
                        description: "test 4",
                        status: "RESOLVED",
                        refund_status: "REFUND",
                        combined_refund_total: "50.75",
                    },
                ],
            }),
        },
    };

    const writes = [];
    const clears = [];
    const sheets = {
        spreadsheets: {
            values: {
                get: async () => ({ data: { values: rows } }),
                batchUpdate: async (request) => {
                    writes.push(request);
                    return { data: {} };
                },
                batchClear: async (request) => {
                    clears.push(request);
                    return { data: {} };
                },
            },
        },
    };

    try {
        const result = await GoogleSheet.repairMixedStyledClaimRows({
            sheets,
            spreadsheetId: "sheet-1",
            sheetTab: "Claims",
            dataStartRow: 2,
        });

        assert.deepEqual(result, { repairedClaims: 1, clearedRows: 1 });
        assert.equal(writes.length, 1);
        assert.equal(writes[0].requestBody.data.length, 1);
        assert.equal(writes[0].requestBody.data[0].range, "'Claims'!A2:AA2");
        assert.equal(writes[0].requestBody.data[0].values[0][1], "2812");
        assert.equal(writes[0].requestBody.data[0].values[0][2], "Resolved");
        assert.equal(writes[0].requestBody.data[0].values[0][6], "Refunded");
        assert.deepEqual(clears[0].requestBody.ranges, ["'Claims'!A51:AA51"]);
    } finally {
        global.Models = originalModels;
    }
});

test("builds automatic refund and reorder summary formulas", () => {
    assert.deepEqual(GoogleSheet.buildSummaryRows(2, 47), [
        ["SUMMARY", ""],
        ["Total Refund", "=SUM(Z2:Z)"],
        ["Total Re-Order", "=SUM(AA2:AA)"],
        ["Total", "=B48+B49"],
    ]);
});

test("converts an invalid Google OAuth client into a reconnect error", () => {
    const googleError = new Error("Google token request failed");
    googleError.response = {
        status: 401,
        data: {
            error: {
                message: "The provided client secret is invalid.",
                errors: [{ reason: "invalid_client" }],
            },
        },
    };

    const normalized = GoogleSheet.normalizeGoogleApiError(googleError);

    assert.equal(normalized.status, 409);
    assert.equal(normalized.code, "GOOGLE_OAUTH_RECONNECT_REQUIRED");
    assert.match(normalized.message, /reconnect the Google Account/i);
});

test("detailed pending claims carry across months, remove completed claims and preserve main claims and totals", async () => {
    const originalModels = global.Models;
    const originalTimezone = process.env.GOOGLE_SHEET_TIMEZONE;
    process.env.GOOGLE_SHEET_TIMEZONE = "Asia/Karachi";
    const merchant = { _id: "699ecac5ba627e480aa4a5a7" };
    const make = (id, extra = {}) => ({
        _id: String(id).padStart(24, "0"), merchant: merchant._id,
        order_name: String(2800 + id), status: "REVIEWING", createdAt: "2026-08-15T00:00:00Z",
        google_sheet_sync_enabled: true, ...extra,
    });
    const august = make(1);
    const july = make(2, { status: "APPROVED", createdAt: "2026-07-15T00:00:00Z", refund_total: 20, reorder_total: 15, merchant_snapshot: { name: "Pending Merchant" }, order_snapshot: { customer_email: "pending@example.com", created_at: "2026-07-14T00:00:00Z" }, description: "Pending note" });
    const main = make(3, { createdAt: "2026-09-15T00:00:00Z", status: "RESOLVED", refund_total: 49.98, reorder_total: 41.99 });
    const records = [august, july, main,
        make(4, { status: "CLOSED" }), make(5, { status: "RESOLVED" }),
        make(6, { google_sheet_sync_enabled: false }), make(7, { merchant: "another-merchant" }),
        make(8, { createdAt: "2026-08-31T19:01:00Z" }), // already September in Karachi
        make(9, { createdAt: "2026-08-31T18:59:00Z" }), // still August
    ];
    global.Models = { Claim: { find: () => { const q = { lean: async () => records }; q.select = () => q; return q; } } };
    const fixture = createSheetFixture([GoogleSheet.getStyledSheetHeaders(), GoogleSheet.mapClaimToStyledRow(main)], 27);
    const target = { sheets: fixture.sheets, spreadsheetId: "pending-months", sheetTab: "September 2026" };
    const pendingRows = (f) => f.rows.filter((row) => String(row[24] || "").startsWith("pending:"));
    const assertPendingColors = () => {
        for (let index = 1; index <= pendingRows(fixture).length; index++) for (const column of [1, 3]) {
            const lastBackground = fixture.requests.map((request) => request.repeatCell).filter((request) => request &&
                request.range.startRowIndex <= index && request.range.endRowIndex > index &&
                (request.range.startColumnIndex || 0) <= column && request.range.endColumnIndex > column &&
                request.cell.userEnteredFormat?.backgroundColor).at(-1);
            assert.deepEqual(lastBackground.cell.userEnteredFormat.backgroundColor, { red: 232 / 255, green: 240 / 255, blue: 254 / 255 });
            assert.deepEqual(lastBackground.cell.userEnteredFormat.textFormat.foregroundColorStyle.rgbColor, { red: 26 / 255, green: 115 / 255, blue: 232 / 255 });
        }
    };
    try {
        await GoogleSheet.ensureSheetLayout(target);
        const mainCells = () => Array.from(fixture.rows.filter((row) => !String(row[24] || "").startsWith("pending:")), (row) => Array.from({ length: 27 }, (_, index) => typeof row?.[index] === "string" ? row[index].replace(/=SUM\((Z|AA)\d+:/, "=SUM($1:") : row?.[index] ?? ""));
        const before = mainCells();
        const first = await GoogleSheet.syncPendingClaimsToTarget(merchant, target);
        assert.equal(first.pending, 3);
        assertPendingColors();
        const detailed = pendingRows(fixture)[0];
        assert.equal(detailed[0], (Date.UTC(2026, 6, 14) - Date.UTC(1899, 11, 30)) / 86400000);
        assert.equal(detailed[1], july.order_name);
        assert.equal(detailed[3], (Date.UTC(2026, 6, 15) - Date.UTC(1899, 11, 30)) / 86400000);
        assert.deepEqual(detailed.slice(4, 10), GoogleSheet.mapClaimToStyledRow(july).slice(4, 10));
        assert.equal(detailed[7], 35);
        assert.ok(fixture.requests.some((request) => request.repeatCell?.range.startColumnIndex === 3 && request.repeatCell.cell.userEnteredFormat?.numberFormat?.pattern === "M/d/yyyy"));
        assert.ok(fixture.requests.some((request) => request.repeatCell?.range.startColumnIndex === 7 && request.repeatCell.cell.userEnteredFormat?.numberFormat?.type === "CURRENCY"));
        assert.equal(fixture.sheet.tables[0].columnProperties[3].columnType, "COLUMN_TYPE_UNSPECIFIED");
        assert.equal(detailed[6], "Refunded/Reordered");
        assert.ok(detailed.slice(25).every((value) => value === ""));
        assert.ok(fixture.requests.some((request) => request.updateBorders?.range.startRowIndex === 1 && request.updateBorders.innerVertical?.style === "SOLID" && request.updateBorders.innerHorizontal?.style === "SOLID"));
        assert.ok(fixture.requests.some((request) => request.repeatCell?.range.startRowIndex === 2 && request.repeatCell.cell.userEnteredFormat?.backgroundColor?.red === 0.95));

        assert.deepEqual(pendingRows(fixture).map((row) => row[24]), [july, august, records[8]].map((claim) => `pending:${claim._id}`));
        assert.deepEqual(mainCells(), before);
        assert.equal(fixture.sheet.tables.length, 1);
        assert.ok(fixture.requests.filter((request) => request.addTable?.table.range?.startColumnIndex === 28 || request.updateTable?.table.range?.startColumnIndex === 28)
            .every((request) => !(request.addTable?.table || request.updateTable?.table).columnProperties));
        await Promise.all(Array.from({ length: 4 }, () => GoogleSheet.syncPendingClaimsToTarget(merchant, target)));
        assert.equal(pendingRows(fixture).length, 3);
        assert.equal(fixture.sheet.tables.length, 1);
        assert.equal(fixture.rows[49][0], "SUMMARY");
        assert.equal(fixture.rows[50][1], "=SUM(Z5:Z)");
        assert.equal(fixture.rows[4][7], 91.97);
        const snapshot = structuredClone(pendingRows(fixture).map((row) => row.slice(0, 40)));
        // Normal main-table migration/sync must not erase or misidentify carryovers.
        await GoogleSheet.syncClaimRowToTarget(main, target, { appendIfMissing: true });
        assert.deepEqual(pendingRows(fixture).map((row) => row.slice(0, 40)), snapshot);
        assertPendingColors();
        assert.equal(fixture.rows.filter((row) => row[24] === main._id).length, 1);
        const added = make(20, { createdAt: "2026-09-20T00:00:00Z", status: "APPROVED" });
        records.push(added);
        await GoogleSheet.syncClaimRowToTarget(added, target, { appendIfMissing: true });
        assert.equal(fixture.rows.filter((row) => row[24] === added._id).length, 1);
        assert.equal(fixture.rows.filter((row) => row[24] === main._id).length, 1);
        assert.deepEqual(pendingRows(fixture).map((row) => row.slice(0, 40)), snapshot);
        assertPendingColors();
        august.status = "RESOLVED";
        august.refund_total = 30;
        august.reorder_total = 25;
        august.resolved_date = "2026-09-18T00:00:00Z";
        july.status = "CLOSED";
        await GoogleSheet.syncPendingClaimsToTarget(merchant, target, { addPending: false });
        assert.equal(pendingRows(fixture).some((row) => row[24] === `pending:${august._id}`), false);
        assert.equal(pendingRows(fixture).some((row) => row[24] === `pending:${july._id}`), false);
        assert.deepEqual([pendingRows(fixture)[0][1], pendingRows(fixture)[0][2]], ["2809", "In Review"]);
        assert.equal(new Date(Date.UTC(1899, 11, 30) + pendingRows(fixture)[0][3] * 86400000).toISOString().slice(0, 10), "2026-08-31");
        assert.ok(pendingRows(fixture).every((row) => row.slice(10, 39).every((cell, index) => index === 14 || cell === "")));
        const october = createSheetFixture([]);
        october.sheet.properties.title = "October 2026";
        await GoogleSheet.syncPendingClaimsToTarget(merchant, { sheets: october.sheets, spreadsheetId: "october", sheetTab: "October 2026" });
        assert.deepEqual(pendingRows(october).map((row) => row[24]), [records[8], records[7], added].map((claim) => `pending:${claim._id}`));
        assert.equal(pendingRows(fixture).length, 1); // completed history lives in original claim tabs
        assert.equal(october.rows.filter((row) => row[24] && !String(row[24]).startsWith("pending:")).length, 1); // header only, no main claims
    } finally {
        global.Models = originalModels;
        if (originalTimezone === undefined) delete process.env.GOOGLE_SHEET_TIMEZONE;
        else process.env.GOOGLE_SHEET_TIMEZONE = originalTimezone;
    }
});

test("pending table refuses occupied areas and unidentifiable rows without changing main data", async () => {
    const originalModels = global.Models;
    global.Models = { Claim: { find: () => ({ lean: async () => [] }) } };
    const merchant = { _id: "699ecac5ba627e480aa4a5a7" };
    try {
        const occupied = createSheetFixture([GoogleSheet.getStyledSheetHeaders()], 40);
        occupied.rows[0][28] = "User data";
        const before = structuredClone(occupied.rows);
        await assert.rejects(GoogleSheet.syncPendingClaimsToTarget(merchant, { sheets: occupied.sheets, spreadsheetId: "occupied", sheetTab: "September 2026" }), /existing data/);
        assert.deepEqual(occupied.rows, before);
        assert.equal(occupied.requests.length, 0);
        const corrupt = createSheetFixture([GoogleSheet.getStyledSheetHeaders()], 40);
        corrupt.rows[0][28] = "Previous Months \u2014 Pending Claims";
        corrupt.rows[3] = [];
        corrupt.rows[3][30] = "Unknown claim";
        await assert.rejects(GoogleSheet.syncPendingClaimsToTarget(merchant, { sheets: corrupt.sheets, spreadsheetId: "corrupt", sheetTab: "September 2026" }), /without its claim ID/);
        assert.equal(corrupt.requests.length, 0);
        const occupiedTop = createSheetFixture([GoogleSheet.getStyledSheetHeaders()], 40);
        const topTarget = { sheets: occupiedTop.sheets, spreadsheetId: "occupied-top", sheetTab: "September 2026" };
        await GoogleSheet.syncPendingClaimsToTarget(merchant, topTarget);
        occupiedTop.rows.splice(1, 0, [46235, "2793", "Approved", ...Array(7).fill(""), "Manual hidden note", ...Array(13).fill(""), "pending:000000000000000000000001"]);
        const topBefore = structuredClone(occupiedTop.rows);
        await assert.rejects(GoogleSheet.syncPendingClaimsToTarget(merchant, topTarget), /unexpected details/);
        assert.deepEqual(occupiedTop.rows, topBefore);
    } finally { global.Models = originalModels; }
});

test("pending duplicate cleanup preserves unrelated main rows", async () => {
    const originalModels = global.Models;
    const merchant = { _id: "699ecac5ba627e480aa4a5a7" };
    const claim = { _id: "000000000000000000000001", merchant: merchant._id, createdAt: "2026-08-10T00:00:00Z", status: "APPROVED", google_sheet_sync_enabled: true };
    global.Models = { Claim: { find: () => { const q = { lean: async () => [claim] }; q.select = () => q; return q; } } };
    const fixture = createSheetFixture([]);
    const target = { sheets: fixture.sheets, spreadsheetId: "pending-dedup", sheetTab: "September 2026" };
    try {
        await GoogleSheet.syncPendingClaimsToTarget(merchant, target);
        fixture.rows.splice(2, 0, structuredClone(fixture.rows[1]));
        fixture.rows[2][2] = "In Review";
        fixture.rows[3][0] = "Keep manual main-table note";
        await GoogleSheet.syncPendingClaimsToTarget(merchant, target);
        assert.equal(fixture.rows.filter((row) => row[24] === 'pending:' + claim._id).length, 1);
        assert.equal(fixture.rows[1][2], "Approved");
        assert.equal(fixture.rows[2][0], "Keep manual main-table note");
        assert.equal(fixture.rows[0][0], "Order Date");
    } finally { global.Models = originalModels; }
});

test("pending carryovers serialize across independent workers without duplicate row insertion", async () => {
    const originalModels = global.Models;
    const merchant = { _id: "699ecac5ba627e480aa4a5a7" };
    const claim = { _id: "000000000000000000000001", merchant: merchant._id, createdAt: "2026-08-10T00:00:00Z", status: "APPROVED", google_sheet_sync_enabled: true };
    const leases = new Map();
    const db = { collection: () => ({
        findOneAndUpdate: async (query, update) => {
            if (leases.has(query._id)) { const error = new Error("duplicate lock"); error.code = 11000; throw error; }
            leases.set(query._id, update.$set);
            return { value: update.$set };
        },
        deleteOne: async (query) => { if (leases.get(query._id)?.owner === query.owner) leases.delete(query._id); },
        updateOne: async () => {},
    }) };
    global.Models = { Claim: { db, find: () => { const q = { lean: async () => [claim] }; q.select = () => q; return q; } } };
    delete require.cache[require.resolve("../services/GoogleSheet")];
    const worker = require("../services/GoogleSheet");
    const fixture = createSheetFixture([]);
    const target = { sheets: fixture.sheets, spreadsheetId: "concurrent-pending", sheetTab: "September 2026" };
    try {
        await Promise.all([
            GoogleSheet.syncPendingClaimsToTarget(merchant, target), worker.syncPendingClaimsToTarget(merchant, target),
            GoogleSheet.syncPendingClaimsToTarget(merchant, target), worker.syncPendingClaimsToTarget(merchant, target),
        ]);
        assert.equal(fixture.rows.filter((row) => row[24] === `pending:${claim._id}`).length, 1);
        assert.equal(fixture.sheet.tables.length, 1);
        assert.equal(fixture.requests.filter((request) => request.insertDimension?.range.dimension === "ROWS").length, 1);
        assert.equal(leases.size, 0);
    } finally { global.Models = originalModels; }
});

test("scheduled month rollover creates current tab without new claims and refreshes every historical copy", async () => {
    const apiPath = require.resolve("../services/GoogleSheetApi");
    const originalApi = require(apiPath);
    require.cache[apiPath].exports = (client) => client;
    const originalModels = global.Models;
    const { google } = require("googleapis");
    const originalSheets = google.sheets;
    const merchant = { _id: "699ecac5ba627e480aa4a5a7", google_sheet_id: "rollover", google_sheet_claim_sync_enabled: true };
    const claim = { _id: "000000000000000000000001", merchant: merchant._id, createdAt: "2026-07-10T00:00:00Z", status: "REVIEWING", google_sheet_sync_enabled: true };
    const fixtures = new Map();
    const getFixture = (range) => fixtures.get(range.match(/^'([^']+)'!/)[1]);
    const sheets = { spreadsheets: {
        get: async () => ({ data: { sheets: [...fixtures.values()].map((fixture) => structuredClone(fixture.sheet)) } }),
        batchUpdate: async ({ requestBody }) => {
            const replies = [];
            for (const request of requestBody.requests) {
                if (request.addSheet) {
                    const fixture = createSheetFixture([]);
                    fixture.sheet.properties.title = request.addSheet.properties.title;
                    fixture.sheet.properties.sheetId = fixtures.size + 1;
                    fixtures.set(fixture.sheet.properties.title, fixture);
                    replies.push({ addSheet: { properties: structuredClone(fixture.sheet.properties) } });
                } else {
                    const definition = Object.values(request)[0];
                    const sheetId = definition.sheetId ?? definition.range?.sheetId ?? definition.properties?.sheetId ?? definition.table?.range?.sheetId;
                    const fixture = [...fixtures.values()].find((entry) => entry.sheet.properties.sheetId === sheetId || entry.sheet.tables.some((table) => table.tableId === definition.table?.tableId));
                    assert.ok(fixture, `Missing sheet for ${Object.keys(request)[0]}`);
                    await fixture.sheets.spreadsheets.batchUpdate({ requestBody: { requests: [request] } });
                }
            }
            return { data: { replies } };
        },
        values: {
            get: (args) => getFixture(args.range).sheets.spreadsheets.values.get(args),
            update: (args) => getFixture(args.range).sheets.spreadsheets.values.update(args),
            clear: (args) => getFixture(args.range).sheets.spreadsheets.values.clear(args),
            batchUpdate: async ({ requestBody }) => {
                for (const item of requestBody.data) await getFixture(item.range).sheets.spreadsheets.values.batchUpdate({ requestBody: { data: [item] } });
            },
            batchClear: async ({ requestBody }) => {
                for (const range of requestBody.ranges) await getFixture(range).sheets.spreadsheets.values.clear({ range });
            },
        },
    } };
    const query = (data) => { const q = { lean: async () => data }; q.select = () => q; return q; };
    global.Models = {
        Claim: { find: () => query([claim]) },
        Merchant: { find: () => query([merchant]), findById: () => query(merchant) },
        GoogleSheetConfig: { findOne: () => query({ client_id: "test", client_secret: "test", refresh_token: "test" }) },
    };
    google.sheets = () => sheets;
    GoogleSheet.resetOAuthClient();
    try {
        const august = await GoogleSheet.refreshMonthlyPendingClaims({ now: new Date("2026-07-31T19:00:00Z") });
        assert.equal(august.merchants, 1);
        assert.ok(fixtures.has("August 2026"));
        assert.equal(fixtures.size, 1);
        await GoogleSheet.refreshMonthlyPendingClaims({ now: new Date("2026-08-31T19:00:00Z") });
        assert.equal(fixtures.size, 2);
        for (const fixture of fixtures.values()) assert.equal(fixture.rows.filter((row) => row[24] === `pending:${claim._id}`).length, 1);
        claim.status = "RESOLVED";
        claim.refund_total = 45;
        await GoogleSheet.syncMerchantPendingClaims(merchant, { now: new Date("2026-09-10T00:00:00Z") });
        for (const fixture of fixtures.values()) assert.equal(fixture.rows.filter((row) => row[24] === `pending:${claim._id}`).length, 0);
        await GoogleSheet.refreshMonthlyPendingClaims({ now: new Date("2026-09-30T19:00:00Z") });
        assert.equal(fixtures.size, 3);
        assert.equal(fixtures.get("October 2026").rows.filter((row) => row[24] === `pending:${claim._id}`).length, 0);
        merchant.google_sheet_claim_sync_enabled = false;
        assert.equal((await GoogleSheet.syncMerchantPendingClaims(merchant, { now: new Date("2026-12-01T00:00:00Z") })).action, "skipped");
        assert.equal(fixtures.size, 3);
    } finally {
        require.cache[apiPath].exports = originalApi;
        global.Models = originalModels;
        google.sheets = originalSheets;
        GoogleSheet.resetOAuthClient();
    }
});

test("Sheets requests are paced, quota rejections retry, and ambiguous writes are not replayed", async () => {
    const paced = require("../services/GoogleSheetApi");
    let time = 0;
    const starts = [];
    let attempts = 0;
    const raw = { spreadsheets: {
        get: async () => { starts.push(time); return "read"; },
        batchUpdate: async () => {
            attempts += 1;
            if (attempts === 1) throw Object.assign(new Error("quota"), { code: 429 });
            return "write";
        },
        values: { update: async () => { throw Object.assign(new Error("connection lost"), { code: 503 }); } },
    } };
    Object.defineProperty(raw, "spreadsheets", { value: raw.spreadsheets, writable: false });
    Object.defineProperty(raw.spreadsheets, "values", { value: raw.spreadsheets.values, writable: false });
    const api = paced(raw, { now: () => time, wait: async (ms) => { time += ms; } });
    assert.notEqual(api.spreadsheets, raw.spreadsheets);
    assert.notEqual(api.spreadsheets.values, raw.spreadsheets.values);
    assert.deepEqual(await Promise.all([api.spreadsheets.get(), api.spreadsheets.get()]), ["read", "read"]);
    assert.deepEqual(starts, [0, 1200]);
    assert.equal(await api.spreadsheets.batchUpdate(), "write");
    assert.equal(attempts, 2);
    await assert.rejects(api.spreadsheets.values.update(), /connection lost/);
    assert.equal(await api.spreadsheets.get(), "read");
});

test("pending rows grow past the main summary without overwriting it or dropping missing records", async () => {
    const originalModels = global.Models;
    const merchant = { _id: "699ecac5ba627e480aa4a5a7" };
    let claims = Array.from({ length: 72 }, (_, index) => ({
        _id: String(index + 1).padStart(24, "0"), merchant: merchant._id,
        google_sheet_sync_enabled: true, createdAt: "2026-08-01T00:00:00Z", status: "REVIEWING",
    }));
    global.Models = { Claim: { find: () => { const q = { lean: async () => claims }; q.select = () => q; return q; } } };
    const fixture = createSheetFixture([]);
    fixture.sheet.properties.gridProperties.rowCount = 60;
    const target = { sheets: fixture.sheets, spreadsheetId: "pending-growth", sheetTab: "September 2026" };
    try {
        await GoogleSheet.syncPendingClaimsToTarget(merchant, target);
        assert.equal(fixture.sheet.properties.gridProperties.rowCount, 132);
        assert.equal(fixture.rows[118][0], "SUMMARY");
        assert.equal(fixture.rows[119][1], "=SUM(Z74:Z)");
        const layout = await GoogleSheet.ensureSheetLayout(target);
        assert.equal(layout.dataStartRow, 2);
        const first = fixture.rows[1].slice(0, 27);
        claims = claims.slice(1);
        await assert.rejects(GoogleSheet.syncPendingClaimsToTarget(merchant, target), /database record is unavailable/);
        assert.equal(fixture.rows.filter((row) => String(row[24] || "").startsWith("pending:")).length, 72);
        assert.deepEqual(fixture.rows[1].slice(0, 27), first);
        assert.equal(fixture.requests.filter((request) => request.insertDimension?.range.dimension === "ROWS").length, 1);
    } finally { global.Models = originalModels; }
});

test("pending verification detects changed main cells even when IDs and totals stay intact", async () => {
    const originalModels = global.Models;
    const merchant = { _id: "699ecac5ba627e480aa4a5a7" };
    const main = { _id: "000000000000000000000010", merchant: merchant._id, status: "RESOLVED", refund_total: 72.49, createdAt: "2026-09-01T00:00:00Z", order_name: "2809" };
    global.Models = { Claim: { find: () => { const q = { lean: async () => [main] }; q.select = () => q; return q; } } };
    const fixture = createSheetFixture([GoogleSheet.getStyledSheetHeaders(), [], GoogleSheet.mapClaimToStyledRow(main)], 27);
    const target = { sheets: fixture.sheets, spreadsheetId: "pending-cell-integrity", sheetTab: "September 2026" };
    try {
        await GoogleSheet.syncPendingClaimsToTarget(merchant, target);
        const original = fixture.sheets.spreadsheets.batchUpdate;
        fixture.sheets.spreadsheets.batchUpdate = async (args) => {
            const result = await original(args);
            if (args.requestBody.requests.some((request) => request.updateCells?.range?.startColumnIndex === 39)) fixture.rows.find((row) => row[24] === main._id)[2] = "Unexpected header";
            return result;
        };
        await assert.rejects(GoogleSheet.syncPendingClaimsToTarget(merchant, target), /Main table changed/);
        assert.equal(fixture.rows.find((row) => row[24] === main._id)[24], main._id);
        assert.equal(fixture.rows.find((row) => row[24] === main._id)[25], 72.49);
    } finally { global.Models = originalModels; }
});

test("moves the old top list beneath the real table header and preserves main updates", async () => {
    const originalModels = global.Models;
    const merchant = { _id: "699ecac5ba627e480aa4a5a7" };
    const pending = { _id: "000000000000000000000001", merchant: merchant._id, order_name: "2793", status: "APPROVED", createdAt: "2026-08-01T00:00:00Z", google_sheet_sync_enabled: true };
    const main = { ...pending, _id: "000000000000000000000099", order_name: "2873", order_snapshot: { created_at: "2026-09-01T00:00:00Z" }, createdAt: "2026-09-01T00:00:00Z", status: "RESOLVED", refund_total: 49.98, reorder_total: 41.99 };
    global.Models = { Claim: { find: () => { const q = { lean: async () => [pending, main] }; q.select = () => q; return q; } } };
    const fixture = createSheetFixture([GoogleSheet.getStyledSheetHeaders(), GoogleSheet.mapClaimToStyledRow(main)], 40);
    const target = { sheets: fixture.sheets, spreadsheetId: "top-to-header", sheetTab: "September 2026" };
    try {
        await GoogleSheet.ensureSheetLayout(target);
        await fixture.sheets.spreadsheets.batchUpdate({ requestBody: { requests: [{ insertDimension: { range: { sheetId: 123, dimension: "ROWS", startIndex: 0, endIndex: 5 } } }] } });
        fixture.rows[0] = ["Previous Months \u2014 Pending Claims"];
        fixture.rows[1] = ["Pending claims: 1"];
        fixture.rows[2] = ["Claim / Order No.", "Original Month", "Status"];
        fixture.rows[3] = ["2793", "August 2026", "Approved", ...Array(36).fill(""), `pending:${pending._id}`];
        fixture.sheet.merges = [0, 1].map((row) => ({ sheetId: 123, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: 3 }));
        await GoogleSheet.syncPendingClaimsToTarget(merchant, target);
        assert.equal(fixture.rows[0][0], "Order Date");
        assert.equal(fixture.sheet.tables[0].range.startRowIndex, 0);
        assert.deepEqual([fixture.rows[1][1], fixture.rows[1][2]], ["2793", "Approved"]);
        assert.equal(fixture.rows[1][24], `pending:${pending._id}`);
        assert.equal(fixture.rows[2][24], main._id);
        assert.equal(fixture.rows[2][7], 91.97);
        await GoogleSheet.syncClaimRowToTarget(main, target, { appendIfMissing: true });
        assert.equal(fixture.rows[1][0], ""); // Missing order date stays blank.
        assert.equal(fixture.rows[1][1], pending.order_name);
        assert.deepEqual(fixture.rows[1].slice(4, 10), GoogleSheet.mapClaimToStyledRow(pending).slice(4, 10));
        assert.ok(fixture.rows[1].slice(10, 24).every((cell) => !cell));
        assert.equal(typeof fixture.rows[2][0], "number");
        assert.equal(new Date(Date.UTC(1899, 11, 30) + fixture.rows[2][0] * 86400000).toISOString().slice(0, 10), "2026-09-01");
        assert.ok(fixture.requests.some((request) => request.repeatCell?.range.startRowIndex === 1 && request.repeatCell.cell.userEnteredFormat?.numberFormat?.pattern === "M/d/yyyy"));
        pending.status = "RESOLVED";
        await GoogleSheet.syncPendingClaimsToTarget(merchant, target);
        assert.equal(fixture.rows[1][24], main._id);
        assert.equal(fixture.rows[1][7], 91.97);
        assert.equal(fixture.rows.filter((row) => String(row[24] || "").startsWith("pending:")).length, 0);
    } finally { global.Models = originalModels; }
});

test("migrates a wide side pending table into detailed rows under the main header", async () => {
    const originalModels = global.Models;
    const merchant = { _id: "699ecac5ba627e480aa4a5a7" };
    const claims = ["REVIEWING", "APPROVED", "RESOLVED", "CLOSED"].map((status, index) => ({
        _id: String(index + 1).padStart(24, "0"), merchant: merchant._id, google_sheet_sync_enabled: true,
        order_name: String(2790 + index), status, createdAt: "2026-08-10T00:00:00Z",
        order_snapshot: { customer_email: "private@example.com" }, description: "Old detailed note", refund_total: 15,
    }));
    global.Models = { Claim: { find: () => { const q = { lean: async () => claims }; q.select = () => q; return q; } } };
    const fixture = createSheetFixture([GoogleSheet.getStyledSheetHeaders()], 40);
    fixture.rows[0][28] = "Previous Months \u2014 Pending Claims";
    fixture.rows[2] = [];
    const oldHeaders = ["Original Claim Month", ...GoogleSheet.getStyledSheetHeaders().slice(0, 10), "pending_claim_id"];
    oldHeaders.forEach((value, index) => { fixture.rows[2][28 + index] = value; });
    claims.forEach((claim, index) => {
        fixture.rows[index + 3] = [];
        ["August 2026", ...GoogleSheet.mapClaimToStyledRow(claim).slice(0, 10), `pending:${claim._id}`].forEach((value, column) => { fixture.rows[index + 3][28 + column] = value; });
    });
    fixture.sheet.tables.push({ tableId: "old-pending", range: { sheetId: 123, startRowIndex: 2, endRowIndex: 7, startColumnIndex: 28, endColumnIndex: 40 } });
    fixture.sheet.merges = [0, 1].map((row) => ({ sheetId: 123, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 28, endColumnIndex: 39 }));
    const target = { sheets: fixture.sheets, spreadsheetId: "compact-migration", sheetTab: "September 2026" };
    try {
        await GoogleSheet.syncPendingClaimsToTarget(merchant, target);
        await GoogleSheet.syncPendingClaimsToTarget(merchant, target);
        assert.deepEqual(fixture.rows[0].slice(0, 3), ["Order Date", "Claim / Order Number", "Status"]);
        assert.deepEqual(fixture.rows.slice(1, 3).map((row) => [row[1], row[2]]), [["2790", "In Review"], ["2791", "Approved"]]);
        assert.ok(fixture.rows.slice(1, 3).every((row) => row.slice(10, 39).every((value, index) => index === 14 || value === "")));
        assert.ok(fixture.rows.slice(6).every((row) => row.slice(28, 40).every((value) => value === "")));
        assert.equal(fixture.sheet.tables.length, 1);
        assert.equal(fixture.requests.filter((request) => request.deleteTable).length, 1);
        assert.ok(fixture.sheet.merges.length === 0);
        assert.ok(fixture.requests.some((request) => request.updateDimensionProperties?.range.startIndex === 10 && request.updateDimensionProperties.properties.hiddenByUser));
        claims[0].status = "RESOLVED";
        claims[1].status = "CLOSED";
        await GoogleSheet.syncPendingClaimsToTarget(merchant, target);
        assert.equal(fixture.rows[0][39], "pending-under-header-v1");
        assert.equal(fixture.rows.filter((row) => row[24]?.startsWith("pending:")).length, 0);
    } finally { global.Models = originalModels; }
});
