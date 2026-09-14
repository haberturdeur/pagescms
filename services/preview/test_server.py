import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import server


def archive(name='root/index.html', kind=tarfile.REGTYPE, content=b'hello'):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as tar:
        info = tarfile.TarInfo(name)
        info.type = kind
        if kind == tarfile.REGTYPE:
            info.size = len(content)
        tar.addfile(info, io.BytesIO(content))
    return stream.getvalue()


class PreviewTests(unittest.TestCase):
    def test_archive_safety(self):
        with tempfile.TemporaryDirectory() as folder:
            server.extract(archive(), folder, True)
            self.assertEqual((Path(folder)/'index.html').read_text(), 'hello')
            for name, kind in [('../outside', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE),
                               ('root/link', tarfile.SYMTYPE), ('root/hard', tarfile.LNKTYPE),
                               ('root/device', tarfile.CHRTYPE), ('root/.git/config', tarfile.REGTYPE)]:
                with self.assertRaises(ValueError):
                    server.extract(archive(name, kind), folder, True)

    def test_worker_isolation(self):
        command = server.worker_command('operator-image:1','/data/source','preview-id','https://preview.example/id/')
        for flag in ['none', '--read-only', '--cap-drop=ALL', '--memory', '--pids-limit']:
            self.assertIn(flag, command)
        self.assertIn('type=bind,src=/data/source,dst=/input,readonly', command)
        self.assertNotIn('docker.sock', ' '.join(command))
        self.assertNotIn('TOKEN', ' '.join(command))
        self.assertEqual(command[-1], 'operator-image:1')

    def test_queue_allowlist_deduplication_and_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            controller = server.Controller(folder,'https://preview.example',{'owner/repo':'worker'})
            with patch.object(controller.pool, 'submit'):
                with self.assertRaises(ValueError):
                    controller.submit('evil/repo','main','a'*40,'secret')
                first = controller.submit('owner/repo','feature/test','a'*40,'secret')
                self.assertEqual(controller.submit('owner/repo','feature/test','b'*40,'secret')['id'], first['id'])
                for branch in ['two','three','four']:
                    controller.submit('owner/repo',branch,'a'*40,'secret')
                with self.assertRaises(ValueError):
                    controller.submit('owner/repo','five','a'*40,'secret')
                self.assertNotIn('secret', (Path(folder)/first['id']/'status.json').read_text())
            restarted = server.Controller(folder,'https://preview.example',{})
            self.assertEqual(restarted.status('owner/repo','feature/test')['status'], 'failed')
            controller.pool.shutdown(); restarted.pool.shutdown()

    def test_success_publishes_complete_output_and_removes_source(self):
        with tempfile.TemporaryDirectory() as folder:
            controller = server.Controller(folder,'https://preview.example',{'owner/repo':'worker'})
            with patch('server.urllib.request.urlopen', return_value=io.BytesIO(archive())) as download, \
                 patch('server.run_worker', return_value=archive('index.html')), \
                 patch('server.subprocess.run'):
                job = controller.submit('owner/repo','main','a'*40,'')
                controller.pool.shutdown(wait=True)
            self.assertNotIn('Authorization', download.call_args.args[0].headers)
            result = controller.status('owner/repo','main')
            self.assertEqual(result['status'], 'ready')
            self.assertTrue((Path(folder)/job['id']/'public'/'index.html').exists())
            self.assertFalse((Path(folder)/job['id']/'source').exists())
            self.assertFalse((Path(folder)/job['id']/'staging').exists())
            self.assertNotIn('test-secret', str(result))

    def test_worker_failure_and_output_limit(self):
        self.assertEqual(server.run_worker(['python3','-c','print("output", end="")']), b'output')
        with self.assertRaisesRegex(ValueError,'Build failed'):
            server.run_worker(['python3','-c','raise SystemExit(1)'])
        with patch.object(server, 'MAX_ARCHIVE', 2):
            with self.assertRaisesRegex(ValueError,'size limit'):
                server.run_worker(['python3','-c','print("too large")'])


if __name__ == '__main__':
    unittest.main()
