import unittest

from app import MAX_FILE_BYTES, decode_source_name, is_authorized, validate_upload_metadata


class UploadValidationTests(unittest.TestCase):
    def test_accepts_allowed_legacy_xls_and_finance_source_kind(self):
        self.assertEqual(
            validate_upload_metadata("payroll.xls", "PAYROLL", 1024),
            ".xls",
        )

    def test_rejects_path_traversal_and_unsupported_extensions(self):
        for name in ("../payroll.xls", "C:\\temp\\payroll.xls", "payroll.xlsm", "script.exe"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                validate_upload_metadata(name, "PAYROLL", 1024)

    def test_rejects_unknown_kind_and_oversized_file(self):
        with self.assertRaises(ValueError):
            validate_upload_metadata("statement.pdf", "OTHER", 100)
        with self.assertRaises(ValueError):
            validate_upload_metadata("statement.pdf", "BANK_STATEMENT", MAX_FILE_BYTES + 1)

    def test_authentication_uses_exact_bearer_token(self):
        self.assertTrue(is_authorized("Bearer secret-token", "secret-token"))
        self.assertFalse(is_authorized("Bearer wrong-token", "secret-token"))
        self.assertFalse(is_authorized("Bearer secret-token", ""))

    def test_decodes_unicode_filename_without_accepting_paths(self):
        import base64

        encoded = base64.urlsafe_b64encode("薪资资料.xls".encode("utf-8")).decode("ascii")
        self.assertEqual(decode_source_name(encoded), "薪资资料.xls")
        path = base64.urlsafe_b64encode("../薪资资料.xls".encode("utf-8")).decode("ascii")
        with self.assertRaises(ValueError):
            validate_upload_metadata(decode_source_name(path), "PAYROLL", 10)


if __name__ == "__main__":
    unittest.main()
