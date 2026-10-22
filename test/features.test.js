'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const FreeList = require('..');

test('validates options without changing the historical enumerable fields', () => {
    for (const options of [false, 1, 'options', [], () => {}]) {
        assert.throws(() => new FreeList('bad', 1, null, options), TypeError);
    }
    for (const key of ['prepare', 'reset', 'validate', 'dispose']) {
        assert.throws(() => new FreeList('bad', 1, null, { [key]: 1 }), TypeError);
    }
    for (const key of ['detectDuplicates', 'statistics']) {
        assert.throws(() => new FreeList('bad', 1, null, { [key]: 'yes' }), TypeError);
    }
    assert.throws(() => new FreeList('bad', 1, null, { statistic: true }), TypeError);
    const options = { statistics: true };
    const pool = new FreeList('options', 1, null, options);
    options.statistics = false;
    assert.notEqual(pool.getStats(), null);
    assert.deepEqual(Object.keys(pool), ['name', 'max', 'constructor', 'list']);
    assert.equal(new FreeList('null', 0, null, null).getStats(), null);
});

test('copies each own option once and ignores inherited hooks', () => {
    let reads = 0;
    const options = Object.create({ reset() { assert.fail('inherited hook'); } });
    Object.defineProperty(options, 'statistics', {
        enumerable: true,
        get() { reads += 1; return true; }
    });
    const pool = new FreeList('own-options', 1, null, options);
    assert.equal(reads, 1);
    pool.free('value');
    assert.equal(pool.getStats().retained, 1);
});

test('reset prepares returned values; validate and prepare receive allocation arguments', () => {
    const events = [];
    const pool = new FreeList('buffers', 2, size => Buffer.alloc(size), {
        reset(value) {
            assert.equal(this, pool);
            value.fill(0);
            events.push('reset');
        },
        validate(value, size) {
            assert.equal(this, pool);
            events.push('validate');
            return value.length >= size;
        },
        prepare(value, size, byte) {
            assert.equal(this, pool);
            value.fill(byte, 0, size);
            events.push('prepare');
        },
        dispose(value, reason) {
            assert.equal(this, pool);
            events.push([reason, value.length]);
        }
    });

    const small = pool.alloc(2);
    assert.deepEqual(events, []); // Factories initialize fresh values.
    small.fill(9);
    pool.free(small);
    assert.deepEqual([...small], [0, 0]);
    const large = Buffer.alloc(4);
    pool.free(large);
    assert.equal(pool.alloc(4, 7), large);
    assert.deepEqual([...large], [7, 7, 7, 7]);
    assert.deepEqual(events, ['reset', 'reset', 'validate', ['invalid', 2], 'validate', 'prepare']);
});

test('a rejected cache candidate leads to factory allocation when none remain', () => {
    const disposed = [];
    const pool = new FreeList('invalid', 1, () => 'new', {
        validate: () => false,
        dispose: (value, reason) => disposed.push([value, reason]),
        statistics: true
    });
    pool.free('old');
    assert.equal(pool.alloc(), 'new');
    assert.deepEqual(disposed, [['old', 'invalid']]);
    assert.equal(pool.getStats().invalid, 1);
    assert.equal(pool.getStats().hits, 0);
    assert.equal(pool.getStats().misses, 1);
});

test('failed validation or preparation preserves the cached candidate', () => {
    const failure = new Error('hook failed');
    for (const hook of ['validate', 'prepare']) {
        let fail = true;
        const pool = new FreeList(hook, 1, null, {
            [hook]() {
                if (fail) throw failure;
                return true;
            }
        });
        const value = {};
        pool.free(value);
        assert.throws(() => pool.alloc(), error => error === failure);
        assert.equal(pool.list[0], value);
        fail = false;
        assert.equal(pool.alloc(), value);
    }
});

test('reset failure leaves ownership with the caller and retains no value', () => {
    const failure = new Error('reset failed');
    const pool = new FreeList('reset', 1, null, {
        reset() { throw failure; },
        dispose() { assert.fail('reset failures are caller-owned'); }
    });
    assert.throws(() => pool.free({}), error => error === failure);
    assert.equal(pool.size, 0);
});

test('full-cache rejection disposes without resetting the rejected value', () => {
    const events = [];
    const pool = new FreeList('full', 1, null, {
        reset: value => events.push(['reset', value]),
        dispose: (value, reason) => events.push([reason, value])
    });
    assert.equal(pool.free('a'), true);
    assert.equal(pool.free('b'), false);
    assert.deepEqual(events, [['reset', 'a'], ['full', 'b']]);
    assert.equal(pool.alloc(), 'a');
});

test('single disposal errors propagate after removing invalid entries', () => {
    const failure = new Error('dispose failed');
    const pool = new FreeList('dispose', 1, null, {
        validate: () => false,
        dispose() { throw failure; }
    });
    pool.free('cached');
    assert.throws(() => pool.free('overflow'), error => error === failure);
    assert.equal(pool.size, 1);
    assert.throws(() => pool.alloc(), error => error === failure);
    assert.equal(pool.size, 0);
});

test('clear attempts every disposal and reports failures after emptying the cache', () => {
    const first = new Error('first');
    const last = new Error('last');
    const seen = [];
    const pool = new FreeList('clear', 3, null, {
        dispose(value, reason) {
            assert.equal(this.size, 0);
            seen.push([value, reason]);
            if (value === 1) throw first;
            if (value === 3) throw last;
        },
        statistics: true
    });
    pool.freeMany([1, 2, 3]);
    assert.throws(() => pool.clear(), error => {
        assert.ok(error instanceof FreeList.DisposalError);
        assert.ok(error instanceof Error);
        assert.equal(error.removed, 3);
        assert.deepEqual(error.failures, [
            { index: 0, value: 1, error: first },
            { index: 2, value: 3, error: last }
        ]);
        return true;
    });
    assert.deepEqual(seen, [[1, 'clear'], [2, 'clear'], [3, 'clear']]);
    assert.equal(pool.size, 0);
    assert.equal(pool.getStats().disposed, 1);
    assert.equal(pool.clear(), 0);
});

test('clear disposes successfully while drain, trim, and resize transfer ownership', () => {
    const disposed = [];
    const pool = new FreeList('transfer', 4, null, { dispose: value => disposed.push(value) });
    pool.freeMany([1, 2, 3, 4]);
    assert.deepEqual(pool.trim(3), [4]);
    assert.deepEqual(pool.resize(2), [3]);
    assert.deepEqual(pool.drain(), [1, 2]);
    assert.deepEqual(disposed, []);
    pool.freeMany([5, 6]);
    assert.equal(pool.clear(), 2);
    assert.deepEqual(disposed, [5, 6]);
});

test('duplicate detection covers object identity, NaN, and signed zero without disposal', () => {
    for (const value of [{}, NaN, 0, undefined, 'value']) {
        const pool = new FreeList('duplicates', 2, null, {
            detectDuplicates: true,
            dispose() { assert.fail('a duplicate is still owned by the pool'); }
        });
        pool.free(value);
        assert.throws(() => pool.free(value), /already cached/);
        assert.equal(pool.size, 1);
        const returned = pool.alloc();
        assert.ok(Object.is(returned, value));
        assert.equal(pool.free(returned), true);
        assert.equal(pool.drain().length, 1);
    }
    const signed = new FreeList('signed-zero', 2, null, { detectDuplicates: true });
    signed.free(0);
    assert.throws(() => signed.free(-0), /already cached/);
});

test('hooks reject reentrant mutation and asynchronous or invalid validation results', () => {
    const mutations = [
        pool => pool.alloc(), pool => pool.free('x'), pool => pool.clear(),
        pool => pool.drain(), pool => pool.trim(0), pool => pool.resize(0),
        pool => pool.preallocate(0), pool => pool.allocMany(0),
        pool => pool.freeMany([]), pool => pool.resetStats()
    ];
    for (const mutate of mutations) {
        const pool = new FreeList('reentry', 1, null, {
            reset() {
                assert.equal(this.size, 0);
                assert.equal(this.getStats(), null);
                mutate(this);
            }
        });
        assert.throws(() => pool.free('value'), /mutation is not allowed/);
        assert.equal(pool.size, 0);
    }
    for (const validate of [() => 1, () => undefined, () => Promise.resolve(true)]) {
        const pool = new FreeList('validation', 1, null, { validate });
        pool.free('value');
        assert.throws(() => pool.alloc(), TypeError);
        assert.equal(pool.size, 1);
    }
    const pool = new FreeList('reset', 1, null, { reset: () => Promise.resolve() });
    assert.throws(() => pool.free('value'), /synchronously/);
    assert.equal(pool.size, 0);
});

test('preallocation reaches a target occupancy and forwards factory arguments', () => {
    const calls = [];
    const pool = new FreeList('warm', 3, function (value) {
        assert.equal(this, pool);
        calls.push(value);
        return { value };
    });
    pool.free({ value: 'old' });
    assert.equal(pool.preallocate(3, 'new'), 2);
    assert.equal(pool.preallocate(2, 'ignored'), 0);
    assert.deepEqual(calls, ['new', 'new']);
    assert.deepEqual(pool.allocMany(3), [{ value: 'old' }, { value: 'new' }, { value: 'new' }]);
    assert.throws(() => pool.preallocate(4), RangeError);
});

test('preallocation reports partial progress and exposes an uncached value on reset failure', () => {
    const failure = new Error('reset');
    let created = 0;
    const pool = new FreeList('warm-failure', 3, () => ({ id: ++created }), {
        reset(value) { if (value.id === 2) throw failure; }
    });
    assert.throws(() => pool.preallocate(3), error => {
        assert.ok(error instanceof FreeList.BatchError);
        assert.equal(error.operation, 'preallocate');
        assert.equal(error.partial, 1);
        assert.equal(error.index, 1);
        assert.equal(error.cause, failure);
        assert.equal(error.created, true);
        assert.deepEqual(error.value, { id: 2 });
        assert.equal(error.cached, false);
        return true;
    });
    assert.equal(pool.size, 1);
    const broken = new FreeList('factory-failure', 1, () => { throw failure; });
    assert.throws(() => broken.preallocate(1), error => {
        assert.equal(error.created, false);
        assert.equal(error.partial, 0);
        assert.equal(error.cause, failure);
        return true;
    });
});

test('preallocation bounds factory reentrancy and disposes newly rejected values', () => {
    let calls = 0;
    const pool = new FreeList('reentrant', 3, function () {
        calls += 1;
        this.alloc();
        return calls;
    });
    pool.free('initial');
    assert.equal(pool.preallocate(3), 2);
    assert.equal(calls, 2);
    assert.equal(pool.size, 1);

    const disposed = [];
    const filled = new FreeList('filled', 1, function () {
        this.free('from-factory');
        return 'created';
    }, { dispose: value => disposed.push(value) });
    assert.equal(filled.preallocate(1), 0);
    assert.deepEqual(disposed, ['created']);
    assert.equal(filled.alloc(), 'from-factory');
});

test('batch allocation and freeing preserve order and report partial failures', () => {
    const failure = new Error('factory');
    let attempts = 0;
    const pool = new FreeList('batches', 2, () => {
        if (++attempts === 2) throw failure;
        return 'created';
    });
    assert.deepEqual(pool.freeMany(['a', 'b', 'c']), [true, true, false]);
    assert.throws(() => pool.allocMany(4), error => {
        assert.ok(error instanceof FreeList.BatchError);
        assert.ok(error instanceof Error);
        assert.equal(error.operation, 'allocMany');
        assert.equal(error.index, 3);
        assert.deepEqual(error.partial, ['a', 'b', 'created']);
        assert.equal(error.cause, failure);
        return true;
    });
    const duplicate = {};
    const strict = new FreeList('strict', 3, null, { detectDuplicates: true });
    assert.throws(() => strict.freeMany([duplicate, duplicate, 'untouched']), error => {
        assert.equal(error.operation, 'freeMany');
        assert.equal(error.index, 1);
        assert.deepEqual(error.partial, [true]);
        return true;
    });
    assert.equal(strict.size, 1);
    assert.deepEqual(pool.allocMany(0), []);
    assert.deepEqual(pool.freeMany([]), []);
    assert.throws(() => pool.freeMany({}), TypeError);
});

test('freeMany snapshots its input before callbacks can change it', () => {
    const values = ['a', 'b'];
    const pool = new FreeList('snapshot', 2, null, {
        reset() { values.length = 0; }
    });
    assert.deepEqual(pool.freeMany(values), [true, true]);
    assert.deepEqual(pool.drain(), ['a', 'b']);
});

test('statistics are opt-in snapshots with explicit reset semantics', () => {
    const disabled = new FreeList('disabled', 1);
    assert.equal(disabled.getStats(), null);
    assert.equal(disabled.resetStats(), null);
    const pool = new FreeList('stats', 1, Number, { statistics: true, dispose() {} });
    assert.equal(pool.alloc(5), 5);
    assert.equal(pool.free(10), true);
    assert.equal(pool.free(11), false);
    assert.equal(pool.alloc(), 10);
    assert.equal(pool.preallocate(1, 12), 1);
    const stats = pool.getStats();
    assert.deepEqual(stats, {
        hits: 1, misses: 1, created: 2, retained: 2, rejected: 1,
        invalid: 0, disposed: 1, highWaterMark: 1, size: 1, capacity: 1
    });
    stats.hits = 100;
    assert.equal(pool.getStats().hits, 1);
    const reset = pool.resetStats();
    assert.equal(reset.hits, 0);
    assert.equal(reset.highWaterMark, 1);
    assert.equal(reset.size, 1);
    pool.clear();
    assert.equal(pool.getStats().disposed, 1);
});

test('rejected async hooks are observed while the public operation fails synchronously', async () => {
    const pool = new FreeList('async-hook', 1, null, {
        async reset() { throw new Error('asynchronous failure'); }
    });
    assert.throws(() => pool.free('value'), /synchronously/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pool.size, 0);
});

test('a malformed thenable cannot leave the pool locked inside a hook', () => {
    let malformed = true;
    const pool = new FreeList('thenable', 1, null, {
        reset() {
            if (malformed) return { then() { throw new Error('broken thenable'); } };
        }
    });
    assert.throws(() => pool.free('first'), /synchronously/);
    malformed = false;
    assert.equal(pool.free('second'), true);
    assert.equal(pool.alloc(), 'second');
});

test('new count arguments reject invalid input before invoking factories or mutating caches', () => {
    let calls = 0;
    const pool = new FreeList('counts', 2, () => ++calls);
    pool.free('cached');
    for (const method of ['preallocate', 'allocMany']) {
        for (const value of [undefined, null, '1', NaN, -1, 0.5, Infinity, 0x100000000]) {
            assert.throws(() => pool[method](value));
            assert.equal(calls, 0);
            assert.deepEqual(pool.list, ['cached']);
        }
    }
    assert.deepEqual(pool.allocMany(3, 'arg'), ['cached', 1, 2]);
});

test('preallocate duplicate failures expose cached ownership and leave the value live', () => {
    const value = {};
    const pool = new FreeList('duplicate-warmup', 2, () => value, { detectDuplicates: true });
    pool.free(value);
    assert.throws(() => pool.preallocate(2), error => {
        assert.equal(error.operation, 'preallocate');
        assert.equal(error.created, true);
        assert.equal(error.cached, true);
        assert.equal(error.value, value);
        assert.equal(error.partial, 0);
        return true;
    });
    assert.equal(pool.alloc(), value);
});

test('lifecycle hooks preserve ownership across mixed allocations, frees, and clears', () => {
    const expected = [];
    const checkedOut = [];
    const disposed = [];
    let nextId = 0;
    let state = 246813579;
    const pool = new FreeList('lifecycle-model', 16, size => ({
        id: ++nextId, capacity: size, active: true
    }), {
        validate(value, size) {
            assert.equal(value.active, false);
            return value.capacity >= size;
        },
        prepare(value) { value.active = true; },
        reset(value) {
            assert.equal(value.active, true);
            value.active = false;
        },
        dispose(value, reason) {
            assert.equal(value.active, reason === 'full');
            disposed.push(value);
        },
        detectDuplicates: true,
        statistics: true
    });

    for (let step = 0; step < 10000; step += 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        if (state % 20 === 0) {
            assert.equal(pool.clear(), expected.length);
            expected.length = 0;
        } else if (state % 2 === 0 && checkedOut.length) {
            const value = checkedOut.pop();
            const accepted = expected.length < 16;
            assert.equal(pool.free(value), accepted);
            if (accepted) expected.push(value);
        } else {
            const size = state % 5;
            while (expected.length && expected[0].capacity < size) expected.shift();
            const candidate = expected.shift();
            const value = pool.alloc(size);
            if (candidate) assert.equal(value, candidate);
            else assert.equal(value.capacity, size);
            assert.equal(value.active, true);
            assert.ok(!checkedOut.includes(value));
            checkedOut.push(value);
        }
        assert.deepEqual(pool.list, expected);
        assert.equal(pool.getStats().size, expected.length);
    }
    assert.equal(new Set(disposed).size, disposed.length);
    assert.equal(pool.getStats().created, nextId);
});
