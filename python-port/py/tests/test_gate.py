import asyncio

import pytest

from vegas_executor.gate import Gate, GateError


def run(coro):
    return asyncio.run(coro)


def test_serial_fifo():
    async def main():
        g = Gate(maxWaitMs=5000, maxRunMs=5000)
        log = []

        async def job(n, d):
            log.append(("start", n))
            await asyncio.sleep(d)
            log.append(("end", n))
            return n

        r = await asyncio.gather(g.run(lambda: job(1, 0.05)), g.run(lambda: job(2, 0.01)), g.run(lambda: job(3, 0)))
        assert r == [1, 2, 3]
        assert log == [("start", 1), ("end", 1), ("start", 2), ("end", 2), ("start", 3), ("end", 3)]
        assert g.queued == 0
    run(main())


def test_error_does_not_block_queue():
    async def main():
        g = Gate()

        async def bad():
            raise ValueError("boom")

        async def ok():
            return "ok"

        t1 = asyncio.ensure_future(g.run(bad))
        t2 = asyncio.ensure_future(g.run(ok))
        with pytest.raises(ValueError):
            await t1
        assert await t2 == "ok"
    run(main())


def test_gate_timeout_never_starts():
    async def main():
        g = Gate(maxWaitMs=50, maxRunMs=5000)
        started = []

        async def slow():
            await asyncio.sleep(0.2)

        async def second():
            started.append(1)

        t1 = asyncio.ensure_future(g.run(slow))
        await asyncio.sleep(0)
        with pytest.raises(GateError) as e:
            await g.run(second, "訊號處理")
        assert e.value.code == "gate_timeout"
        assert "訊號處理" in str(e.value)
        assert started == []          # 逾時的那一筆絕不執行
        await t1
    run(main())


def test_run_timeout_releases_caller_but_not_work():
    async def main():
        g = Gate(maxWaitMs=5000, maxRunMs=50)
        done = []

        async def slow():
            await asyncio.sleep(0.15)
            done.append("slow")

        async def nxt():
            done.append("next")

        with pytest.raises(GateError) as e:
            await g.run(slow, "下單")
        assert e.value.code == "run_timeout"
        assert done == []             # 呼叫端被放掉時工作仍在跑
        await g.run(nxt)              # 下一筆要等前一筆自然結束
        assert done == ["slow", "next"]
    run(main())
