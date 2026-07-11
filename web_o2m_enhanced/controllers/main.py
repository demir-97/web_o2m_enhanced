import base64
import csv
import io
import json

from odoo import http
from odoo.http import content_disposition, request

XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'


class O2mEnhancedController(http.Controller):

    @http.route('/web_o2m_enhanced/export_xlsx', type='http', auth='user', methods=['POST'])
    def export_xlsx(self, data, **kwargs):
        """Build an xlsx file from rows collected client-side (the embedded
        list's visible/filtered rows, including unsaved ones)."""
        import xlsxwriter  # vendored with Odoo

        payload = json.loads(data)
        headers = payload['headers']
        types = payload['types']
        rows = payload['rows']
        filename = (payload.get('filename') or 'export') + '.xlsx'

        output = io.BytesIO()
        workbook = xlsxwriter.Workbook(output, {'in_memory': True})
        sheet = workbook.add_worksheet()
        header_format = workbook.add_format({
            'bold': True, 'bg_color': '#875A7B', 'font_color': '#FFFFFF',
        })
        widths = [len(str(header)) for header in headers]
        for col, header in enumerate(headers):
            sheet.write(0, col, str(header), header_format)
        for row_index, row in enumerate(rows, start=1):
            for col, cell in enumerate(row):
                if cell is None or cell is False or cell == '':
                    continue
                cell_type = types[col] if col < len(types) else 'char'
                if cell_type in ('id', 'integer', 'float', 'monetary') and isinstance(cell, (int, float)):
                    sheet.write_number(row_index, col, cell)
                elif cell_type == 'boolean':
                    sheet.write_boolean(row_index, col, bool(cell))
                else:
                    sheet.write_string(row_index, col, str(cell))
                widths[col] = max(widths[col], len(str(cell)))
        for col, width in enumerate(widths):
            sheet.set_column(col, col, min(max(width + 2, 10), 60))
        sheet.freeze_panes(1, 0)
        workbook.close()

        return request.make_response(output.getvalue(), headers=[
            ('Content-Type', XLSX_MIME),
            ('Content-Disposition', content_disposition(filename)),
        ])

    @http.route('/web_o2m_enhanced/parse_spreadsheet', type='json', auth='user')
    def parse_spreadsheet(self, filename, content):
        """Parse an uploaded xlsx/csv file (base64) into a header row and data
        rows; cell interpretation happens client-side against the list's
        columns."""
        data = base64.b64decode(content)
        if (filename or '').lower().endswith('.csv'):
            rows = self._parse_csv(data)
        else:
            rows = self._parse_xlsx(data)
        # Drop fully empty rows (trailing spreadsheet rows etc.).
        rows = [row for row in rows if any(cell not in (None, '') for cell in row)]
        if not rows:
            return {'headers': [], 'rows': []}
        headers = ['' if cell is None else str(cell).strip() for cell in rows[0]]
        return {'headers': headers, 'rows': rows[1:]}

    def _parse_csv(self, data):
        text = data.decode('utf-8-sig', errors='replace')
        try:
            dialect = csv.Sniffer().sniff(text[:4096], delimiters=',;\t')
        except csv.Error:
            dialect = csv.excel
        return list(csv.reader(io.StringIO(text), dialect))

    def _parse_xlsx(self, data):
        import openpyxl  # vendored with Odoo (base_import)

        workbook = openpyxl.load_workbook(
            io.BytesIO(data), read_only=True, data_only=True)
        try:
            rows = []
            for row in workbook.worksheets[0].iter_rows(values_only=True):
                rows.append([
                    # date/datetime cells -> ISO strings, the client parses them
                    cell.isoformat() if hasattr(cell, 'isoformat') else cell
                    for cell in row
                ])
            return rows
        finally:
            workbook.close()
