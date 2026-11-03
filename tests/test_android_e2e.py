"""Contract tests for authentication handling and lossless snapshot parsing."""
import importlib.util
from pathlib import Path
import unittest
import urllib.request

spec = importlib.util.spec_from_file_location(
    "android_e2e", Path(__file__).resolve().parents[1] / "scripts/fetch-android-e2e.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ExportTests(unittest.TestCase):
    def test_login_html_is_rejected_even_with_http_200(self):
        with self.assertRaises(module.DataError):
            module.check_response(module.BASE, module.BASE, "text/html", b"<html>login</html>")
        with self.assertRaises(module.DataError):
            module.check_response(module.BASE, "https://accounts.feishu.cn/login", "text/html", b"login")

    def test_redirect_does_not_forward_cookie_to_login_host(self):
        req = urllib.request.Request(module.BASE, headers={"Cookie": "test=secret"})
        with self.assertRaises(module.DataError):
            module.SameOriginRedirect().redirect_request(
                req, None, 302, "Found", {}, "https://accounts.feishu.cn/login")

    def test_official_asset_redirect_removes_credentials(self):
        req = urllib.request.Request(module.BASE + 'price-data.js',
                                     headers={"Cookie": "test=secret", "Authorization": "Bearer test"})
        url = 'https://lf-miaoda-compiled-static.feishucdn.com/app_17h053qz13d/9/price-data.js'
        redirected = module.SameOriginRedirect().redirect_request(req, None, 302, 'Found', {}, url)
        self.assertIsNone(redirected.get_header('Cookie'))
        self.assertIsNone(redirected.get_header('Authorization'))
        module.check_response(req.full_url, url, 'application/javascript', b'window.PRICE_DATA={}')

    def test_parses_json_without_executing_trailing_js(self):
        source = 'var BOARD_DATA={"models":[],"value":null};throw new Error("never execute");'
        self.assertEqual(module.parse_assignment(source, "BOARD_DATA"), {"models": [], "value": None})
        with self.assertRaises(module.DataError):
            module.parse_assignment('window.PRICE_DATA={"models":{},"x":NaN};', "PRICE_DATA")

    def test_daily_join_preserves_zero_missing_and_ratio_positions(self):
        board = {"meta": {"dates": ["2026-11-01"], "brands": ["OPPO"]},
                 "models": [{"n": "OPPO K10", "b": 0, "t": 0}],
                 "inv": [[[0, 12, 2, 2, 1.33, 1.17]]],
                 "flow": [[[0, 0, 1, 2, 3]]], "order": [[]],
                 "sales": [[[0, 0, 2, 0]]], "delivery": [[]]}
        models = module.model_rows(board, {"models": {}})
        row, = module.daily_rows(board, models)
        self.assertEqual(row["purchase_sales_ratio_3d"], 1.33)
        self.assertEqual(row["purchase_sales_ratio_7d"], 1.17)
        self.assertEqual(row["submit_self"], 0)
        self.assertIsNone(row["deal_self"])
        self.assertIsNone(row["listing_date"])
        board['inv'][0].append(board['inv'][0][0])
        with self.assertRaises(module.DataError):
            module.daily_rows(board, models)

    def test_price_axis_mismatch_is_reported_without_changing_values(self):
        variant = {"dc": ["2026-11-01"], "base": [10, 20]}
        data = {"PRICE_DATA": {"models": {"test": {"s1": {"key": variant}}}},
                "S4_DATA": {"models": {}}}
        report = module.quality_report(data)
        self.assertEqual(report['array_length_mismatches'], {"s1.base": 1})
        self.assertEqual(variant['base'], [10, 20])


if __name__ == '__main__':
    unittest.main()
