"""Run the local server independently with persistent diagnostic output."""
from datetime import datetime
import faulthandler
import os
from pathlib import Path
import runpy
import sys
import traceback


def main():
    root = Path(__file__).resolve().parent
    os.chdir(root)
    with (root / 'server.log').open('a', encoding='utf-8', buffering=1) as output, \
            (root / 'server-error.log').open('a', encoding='utf-8', buffering=1) as errors:
        sys.stdout = output
        sys.stderr = errors
        faulthandler.enable(file=errors)
        stamp = lambda: datetime.now().astimezone().isoformat(timespec='seconds')
        print(f'[{stamp()}] Starting background server pid={os.getpid()}', file=errors)
        sys.argv[0] = str(root / 'server.py')
        try:
            runpy.run_path(sys.argv[0], run_name='__main__')
        except BaseException:
            traceback.print_exc(file=errors)
            raise
        finally:
            print(f'[{stamp()}] Background server exited pid={os.getpid()}', file=errors)
            faulthandler.disable()
            sys.stdout = sys.__stdout__
            sys.stderr = sys.__stderr__


if __name__ == '__main__':
    main()
