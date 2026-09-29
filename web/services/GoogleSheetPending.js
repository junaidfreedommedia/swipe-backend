// Shared main headings, then detailed previous-month pending rows, then originals.
const TITLE = "Previous Months \u2014 Pending Claims";
const MARKER = "pending-under-header-v1"; // AN1, outside main header writes
const END_COLUMN = 40;
const BLACK = { red: 0, green: 0, blue: 0 };
const PENDING_BACKGROUND = { red: 232 / 255, green: 240 / 255, blue: 254 / 255 }; // #E8F0FE
const PENDING_TEXT = { red: 26 / 255, green: 115 / 255, blue: 232 / 255 }; // #1A73E8
const isPending = (claim) => ["REVIEWING", "IN_REVIEW", "APPROVED"].includes(claim.status);
const claimId = (claim) => String(claim?._id || "");
const merchantId = (claim) => String(claim?.merchant?._id || claim?.merchant || "");
const rowId = (row, column = 24) => /^pending:[a-f0-9]{24}$/i.test(String(row?.[column] || "")) ? row[column].slice(8) : "";
const occupied = (row) => row?.some((value) => value !== "" && value != null);
const placeholderOnly = (row = []) => row.every((value) =>
    ["", "Claim / Order Number", "m/d/yyyy", "$xx", "Notes"].includes(String(value ?? "").trim()));
const headerIndex = (rows) => rows.findIndex((row) => String(row?.[0]).trim().toLowerCase() === "order date" && String(row?.[1]).trim().toLowerCase() === "claim / order number");
const canonical = (rows = []) => {
    const result = Array.from(rows, (row) => {
        const cells = Array.from(row || [], (value) => typeof value === "string" ? value.replace(/^=SUM\((Z|AA)\d+:(Z|AA)\)$/, "=SUM($1:$2)") : value ?? "");
        while (cells.at(-1) === "") cells.pop();
        return cells;
    });
    while (result.length && !result.at(-1).length) result.pop();
    return JSON.stringify(result);
};

module.exports = (helpers) => {
    const {
        getClaimModel, getMerchantModel, findMerchant, getStoredMerchantTarget,
        hasOAuthConfig, isMerchantSheetSyncEnabled, getClaimMonthSheetTab,
        getMonthlySheetSortKey, isMonthlySheetTab, mapClaimToStyledRow,
        ensureSpreadsheetTab, ensureSheetLayoutUnlocked, withStyledSheetWriteLock,
        getSheetRange, getLogger,
    } = helpers;

    const syncPendingClaimsToTarget = (merchant, target, { addPending = true } = {}) =>
        withStyledSheetWriteLock(target, async () => {
            const { sheets, spreadsheetId, sheetTab } = target;
            if (!isMonthlySheetTab(sheetTab)) throw new Error("Pending claims require a monthly tab");
            const metadata = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties,tables,merges)" });
            const sheet = metadata.data.sheets?.find((entry) => entry.properties.title === sheetTab);
            if (!sheet) throw new Error(`Monthly tab not found: ${sheetTab}`);
            const sheetId = sheet.properties.sheetId;
            const columns = sheet.properties.gridProperties.columnCount;
            const read = async (cells) => (await sheets.spreadsheets.values.get({ spreadsheetId, range: getSheetRange(sheetTab, cells), valueRenderOption: "UNFORMATTED_VALUE" })).data.values || [];
            const all = await read(`A1:${columns >= 40 ? "AN" : columns >= 27 ? "AA" : "Z"}`);
            const top = all[0]?.[0] === TITLE;
            const side = all[0]?.[28] === TITLE;
            const inline = all[0]?.[39] === MARKER;
            const managed = top || side || inline;
            if (!managed && !addPending) return { action: "skipped" };
            if ([top, side, inline].filter(Boolean).length > 1) throw new Error(`Multiple pending sections in ${sheetTab}; refusing ambiguous migration`);
            let mainHeader = headerIndex(all);
            if (top && mainHeader < 4) throw new Error(`Cannot find the main table below pending claims in ${sheetTab}`);
            if (!top && mainHeader > 0) throw new Error(`Existing content above the main header in ${sheetTab}; refusing to replace it`);
            if (inline && mainHeader !== 0) throw new Error(`Main claim header missing in ${sheetTab}`);
            if (!managed && all.some((row) => occupied(row.slice(28, 40)))) throw new Error(`Pending area in ${sheetTab} contains existing data; refusing to overwrite it`);
            const inlineRows = inline ? all.slice(1).filter((row) => rowId(row)) : [];
            // A cleared carryover leaves a hole, not a shorter pending block.
            // Recover only empty/template cells before the last pending ID.
            // An original claim or any other content in that span remains unsafe.
            const oldCount = inline ? Math.max(0, all.findLastIndex((row) => rowId(row))) : 0;
            const pendingSpan = inline ? all.slice(1, oldCount + 1) : [];
            if (pendingSpan.some((row) => !rowId(row) && !placeholderOnly(row))) throw new Error(`Pending rows in ${sheetTab} are outside their leading block; refusing to move unrelated claims`);
            const recoveredGaps = pendingSpan.filter((row) => !rowId(row)).length;
            const existing = inline ? inlineRows : top ? all.slice(3, mainHeader) : side ? all.slice(3).map((row) => [...Array(28).fill(""), ...row.slice(28, 40)]) : [];
            const idColumn = inline ? 24 : 39;
            if (existing.some((row) => occupied(row) && !rowId(row, idColumn))) throw new Error(`Pending area in ${sheetTab} has a row without its claim ID; refusing to overwrite it`);
            if (top && all.slice(0, mainHeader).some((row) => occupied(row.slice(3, 39)))) throw new Error(`Pending area in ${sheetTab} contains existing data outside its list`);
            if (inline && existing.some((row) => row.some((value, index) => index > 9 && index !== 24 && value !== "" && value != null))) throw new Error(`Pending row in ${sheetTab} contains unexpected details; refusing to overwrite it`);
            const existingIds = [...new Set(existing.map((row) => rowId(row, idColumn)).filter(Boolean))];
            const records = await getClaimModel().find({ merchant: merchant._id, $or: [{ google_sheet_sync_enabled: true }, { _id: { $in: existingIds } }] }).lean();
            const scoped = records.filter((record) => merchantId(record) === String(merchant._id));
            const byId = new Map(scoped.map((record) => [claimId(record), record]));
            const monthKey = getMonthlySheetSortKey(sheetTab);
            const eligible = (record) => record.google_sheet_sync_enabled === true && record.createdAt && isPending(record) && getMonthlySheetSortKey(getClaimMonthSheetTab(record)) < monthKey;
            for (const id of existingIds) if (!byId.has(id)) throw new Error(`Cannot verify pending claim ${id}; its database record is unavailable`);
            const claims = scoped.filter((record) => eligible(record) && (addPending || existingIds.includes(claimId(record))))
                .filter((record, index, list) => list.findIndex((other) => claimId(other) === claimId(record)) === index)
                .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || claimId(a).localeCompare(claimId(b)));
            if (!top && !inline) await ensureSheetLayoutUnlocked(target);
            const mainValues = await read("A1:AA");
            mainHeader = headerIndex(mainValues);
            if (mainHeader < 0) throw new Error(`Main claim header missing in ${sheetTab}`);
            let mainTable = (sheet.tables || []).find((table) => (table.range?.startColumnIndex || 0) === 0 && (table.range?.startRowIndex || 0) === mainHeader);
            if (!mainTable) {
                const refreshed = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(sheetId),tables)" });
                mainTable = refreshed.data.sheets?.find((entry) => entry.properties.sheetId === sheetId)?.tables?.find((table) => (table.range?.startColumnIndex || 0) === 0 && (table.range?.startRowIndex || 0) === mainHeader);
            }
            if (!mainTable?.columnProperties?.length) throw new Error(`Main table column definitions missing in ${sheetTab}`);
            const before = mainValues.filter((row, index) => index >= mainHeader && !(inline && index > 0 && index <= oldCount) && !rowId(row));
            const requests = [];
            if (Math.max(27, columns) < 40) requests.push({ appendDimension: { sheetId, dimension: "COLUMNS", length: 40 - Math.max(27, columns) } });
            if (side) {
                for (const table of sheet.tables || []) if (table.range?.startColumnIndex === 28 && table.range?.startRowIndex === 2) requests.push({ deleteTable: { tableId: table.tableId } });
                for (const merge of sheet.merges || []) if (merge.startColumnIndex === 28 && merge.endRowIndex <= 2) requests.push({ unmergeCells: { range: merge } });
                requests.push({ updateCells: { range: { sheetId, startRowIndex: 0, endRowIndex: Math.max(4, all.length), startColumnIndex: 28, endColumnIndex: 40 }, rows: [], fields: "userEnteredValue,userEnteredFormat,dataValidation,note" } });
            }
            if (top) {
                for (const merge of sheet.merges || []) if ((merge.startColumnIndex || 0) === 0 && merge.endColumnIndex === 3 && merge.endRowIndex <= 2) requests.push({ unmergeCells: { range: merge } });
                requests.push({ deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: mainHeader } } });
            }
            // Resize only the leading pending block. Main headings remain row 1.
            // All structure, values and marker updates share one atomic batch.
            if (claims.length > oldCount) requests.push({ insertDimension: { range: { sheetId, dimension: "ROWS", startIndex: oldCount + 1, endIndex: claims.length + 1 }, inheritFromBefore: false } });
            if (claims.length < oldCount) requests.push({ deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: claims.length + 1, endIndex: oldCount + 1 } } });
            // A contains order dates for both carryovers and originals.
            // Keep numeric dates and explicit formats when refreshing old layouts.
            // Blue Order Number and Claim Date cells identify previous-month carryovers.
            requests.push({ updateTable: { table: { tableId: mainTable.tableId, columnProperties: mainTable.columnProperties.map((column) => [0, 3].includes(column.columnIndex || 0) ? { ...column, columnType: claims.length ? "COLUMN_TYPE_UNSPECIFIED" : "DATE" } : column) }, fields: "columnProperties" } });
            for (const column of [0, 3]) requests.push({ repeatCell: { range: { sheetId, startRowIndex: claims.length + 1, endRowIndex: sheet.properties.gridProperties.rowCount - (top ? mainHeader : 0) + claims.length - oldCount, startColumnIndex: column, endColumnIndex: column + 1 }, cell: { userEnteredFormat: { numberFormat: { type: "DATE", pattern: "M/d/yyyy" } } }, fields: "userEnteredFormat.numberFormat" } });
            requests.push({ updateCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 39, endColumnIndex: 40 }, rows: [{ values: [{ userEnteredValue: { stringValue: MARKER } }] }], fields: "userEnteredValue" } });
            if (claims.length) {
                const rows = claims.map((claim) => {
                    const cells = Array.from({ length: 40 }, () => ({ userEnteredValue: { stringValue: "" } }));
                    const details = mapClaimToStyledRow(claim);
                    for (let column = 0; column < 10; column++) {
                        const value = details[column] ?? "";
                        cells[column].userEnteredValue = typeof value === "number" ? { numberValue: value } : { stringValue: String(value) };
                    }
                    for (const column of [0, 3]) {
                        const date = String(details[column] || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
                        if (date) cells[column].userEnteredValue = { numberValue: (Date.UTC(Number(date[3]), Number(date[1]) - 1, Number(date[2])) - Date.UTC(1899, 11, 30)) / 86400000 };
                    }
                    cells[0].note = `Previous month's pending claim. Order date: ${details[0] || "not available"}.`;
                    cells[3].note = `Original claim date: ${details[3] || "not available"}.`;
                    // Display the processed amount, but never duplicate the original
                    // row's refund/reorder totals in hidden Z/AA.
                    cells[24].userEnteredValue.stringValue = `pending:${claimId(claim)}`;
                    return { values: cells };
                });
                const pendingRange = { sheetId, startRowIndex: 1, endRowIndex: claims.length + 1, startColumnIndex: 0, endColumnIndex: 10 };
                requests.push(
                    { updateCells: { range: { ...pendingRange, endColumnIndex: 40 }, rows, fields: "userEnteredValue,userEnteredFormat,dataValidation,note" } },
                    { repeatCell: { range: pendingRange, cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 1 }, textFormat: { fontFamily: "Arial", fontSize: 10, foregroundColorStyle: { rgbColor: BLACK } }, verticalAlignment: "MIDDLE" } }, fields: "userEnteredFormat" } },
                    { repeatCell: { range: { ...pendingRange, endColumnIndex: 1 }, cell: { userEnteredFormat: { numberFormat: { type: "DATE", pattern: "M/d/yyyy" }, horizontalAlignment: "RIGHT" } }, fields: "userEnteredFormat.numberFormat,userEnteredFormat.horizontalAlignment" } },
                    { repeatCell: { range: { ...pendingRange, startColumnIndex: 3, endColumnIndex: 4 }, cell: { userEnteredFormat: { numberFormat: { type: "DATE", pattern: "M/d/yyyy" }, textFormat: { foregroundColorStyle: { rgbColor: BLACK } } } }, fields: "userEnteredFormat.numberFormat,userEnteredFormat.textFormat.foregroundColorStyle" } },
                    { repeatCell: { range: { ...pendingRange, startColumnIndex: 7, endColumnIndex: 8 }, cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } } }, fields: "userEnteredFormat.numberFormat" } },
                    { updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 1, endIndex: claims.length + 1 }, properties: { pixelSize: 28 }, fields: "pixelSize" } },
                );
                const border = { style: "SOLID", color: BLACK };
                requests.push({ updateBorders: { range: pendingRange, top: border, bottom: border, left: border, right: border, innerHorizontal: border, innerVertical: border } });
                for (let index = 0; index < claims.length; index++) {
                    requests.push({ repeatCell: { range: { ...pendingRange, startRowIndex: index + 1, endRowIndex: index + 2 }, cell: { userEnteredFormat: { backgroundColor: index % 2 ? { red: 0.95, green: 0.96, blue: 0.97 } : { red: 1, green: 1, blue: 1 } } }, fields: "userEnteredFormat.backgroundColor" } });
                }
                for (const column of [1, 3]) requests.push({ repeatCell: { range: { ...pendingRange, startColumnIndex: column, endColumnIndex: column + 1 }, cell: { userEnteredFormat: { backgroundColor: PENDING_BACKGROUND, textFormat: { foregroundColorStyle: { rgbColor: PENDING_TEXT } } } }, fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.foregroundColorStyle" } });
            }
            requests.push(
                { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 10, endIndex: 40 }, properties: { hiddenByUser: true }, fields: "hiddenByUser" } },
                { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
                { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 }, cell: { note: `Previous months' pending claims: ${claims.length}. Blue Order Number and Claim Date cells mark pending carryovers listed first; current-month claims follow. Pending amounts are excluded from totals.` }, fields: "note" } },
            );
            await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
            const after = (await read("A1:AA")).filter((row) => !rowId(row));
            if (canonical(before) !== canonical(after)) throw new Error(`Main table changed while updating pending claims in ${sheetTab}; inspect sheet before retrying`);
            const saved = await read(`A1:AN${claims.length + 1}`);
            const ids = saved.map((row) => rowId(row)).filter(Boolean);
            if (saved[0]?.[39] !== MARKER || ids.length !== claims.length || new Set(ids).size !== claims.length || claims.some((claim) => !ids.includes(claimId(claim)))) throw new Error(`Pending rows failed read-back verification in ${sheetTab}`);
            if (recoveredGaps) getLogger().info(`[GoogleSheet] Recovered empty pending rows. tab=${sheetTab} rows=${recoveredGaps} pending=${claims.length}`);
            return { action: managed ? "updated" : "created", sheetTab, pending: claims.length, completed: 0, rows: claims.length };
        });

    const syncMerchantPendingClaims = async (merchantOrId, { now = new Date() } = {}) => {
        const merchant = await findMerchant(merchantOrId);
        if (!merchant || !isMerchantSheetSyncEnabled(merchant) || !merchant.google_sheet_id) return { action: "skipped" };
        const target = await getStoredMerchantTarget(merchant);
        const currentTab = getClaimMonthSheetTab({ createdAt: now });
        await ensureSpreadsheetTab({ ...target, sheetTab: currentTab });
        const response = await target.sheets.spreadsheets.get({ spreadsheetId: target.spreadsheetId, fields: "sheets.properties" });
        const tabs = (response.data.sheets || []).filter((sheet) => isMonthlySheetTab(sheet.properties.title) &&
            getMonthlySheetSortKey(sheet.properties.title) <= getMonthlySheetSortKey(currentTab));
        const results = [];
        for (const sheet of tabs) {
            // Old tabs only update existing copies. Never insert today's pending
            // list into a historical month that did not originally contain it.
            if (sheet.properties.title !== currentTab && sheet.properties.gridProperties.columnCount < END_COLUMN) continue;
            results.push(await syncPendingClaimsToTarget(merchant, { ...target, sheetTab: sheet.properties.title }, { addPending: sheet.properties.title === currentTab }));
        }
        return { action: "synced", results };
    };

    const refreshMonthlyPendingClaims = async ({ now = new Date() } = {}) => {
        if (!(await hasOAuthConfig())) return { action: "skipped", reason: "not_configured" };
        const merchants = await getMerchantModel().find({ google_sheet_claim_sync_enabled: true, google_sheet_id: { $nin: [null, ""] } }).lean();
        const results = [];
        const errors = [];
        for (const merchant of merchants) {
            if (!merchant.google_sheet_id) continue;
            try { results.push(await syncMerchantPendingClaims(merchant, { now })); }
            catch (error) {
                errors.push(String(merchant._id));
                getLogger().error(`[GoogleSheet] Pending refresh failed for merchant ${merchant._id}: ${error.message}`);
            }
        }
        if (errors.length) throw new Error(`Google Sheet pending refresh failed for ${errors.length} merchant(s); next scheduled run will retry`);
        getLogger().info(`[GoogleSheet] Monthly pending refresh completed for ${results.length} merchant(s)`);
        return { action: "synced", merchants: results.length };
    };

    return { syncPendingClaimsToTarget, syncMerchantPendingClaims, refreshMonthlyPendingClaims };
};
