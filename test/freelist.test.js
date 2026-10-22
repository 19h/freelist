'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const FreeList = require('..');

test('both CommonJS exports refer to the same constructor', () => {
    assert.equal(FreeList.FreeList, FreeList);
    assert.ok(new FreeList.FreeList('legacy', 1) instanceof FreeList);
});

test('exposes the original metadata, factory, and free-value array', () => {
    const factory = () => ({});
    const pool = new FreeList('objects', 2, factory);

    assert.equal(pool.name, 'objects');
    assert.equal(pool.max, 2);
    assert.equal(pool.constructor, factory);
    assert.deepEqual(pool.list, []);
    const list = pool.list;
    const value = {};
    pool.free(value);
    assert.equal(pool.list, list);
    assert.equal(pool.list[0], value);
    assert.equal(pool.alloc(), value);
    assert.equal(pool.list, list);
    assert.equal(pool.list.length, 0);
});

test('returns cached values in FIFO order before invoking the factory', () => {
    let calls = 0;
    const pool = new FreeList('numbers', 2, value => {
        calls += 1;
        return Number(value);
    });

    assert.equal(pool.free(100), true);
    assert.equal(pool.free(101), true);
    assert.equal(pool.free(102), false);
    assert.equal(pool.alloc(123), 100);
    assert.equal(pool.alloc(123), 101);
    assert.equal(calls, 0);
    assert.equal(pool.alloc('123'), 123);
    assert.equal(calls, 1);
});

test('forwards arguments and pool context to a factory without using new', () => {
    let receiver;
    let argumentsSeen;
    const pool = new FreeList('context', 0, function () {
        receiver = this;
        argumentsSeen = Array.from(arguments);
        return 42;
    });

    assert.equal(pool.alloc('a', 3, null), 42);
    assert.equal(receiver, pool);
    assert.deepEqual(argumentsSeen, ['a', 3, null]);
});

test('a zero-capacity pool always invokes the factory and rejects frees', () => {
    let calls = 0;
    const pool = new FreeList('disabled', 0, () => ++calls);

    assert.equal(pool.free('discarded'), false);
    assert.equal(pool.alloc(), 1);
    assert.equal(pool.alloc(), 2);
    assert.deepEqual(pool.list, []);
});

test('omitted and null factories return undefined when the pool is empty', () => {
    for (const factory of [undefined, null]) {
        const pool = new FreeList('default', 1, factory);
        assert.equal(typeof pool.constructor, 'function');
        assert.equal(pool.alloc(), undefined);
        assert.equal(pool.free('cached'), true);
        assert.equal(pool.alloc(), 'cached');
        assert.equal(pool.alloc(), undefined);
    }
});

test('stores every JavaScript value, including falsy values, by identity', () => {
    const values = [undefined, null, false, 0, -0, 1n, '', NaN, {}, () => {}, Symbol('x')];
    const pool = new FreeList('values', values.length, () => {
        assert.fail('factory must not run while cached values remain');
    });

    for (const value of values) assert.equal(pool.free(value), true);
    for (const value of values) assert.ok(Object.is(pool.alloc(), value));
    assert.equal(pool.list.length, 0);
});

test('reuses mutable objects without resetting them or detecting duplicates', () => {
    const pool = new FreeList('objects', 2);
    const object = { state: 'retained' };

    assert.equal(pool.free(object), true);
    assert.equal(pool.free(object), true);
    assert.equal(pool.alloc(), object);
    assert.equal(pool.alloc(), object);
    assert.equal(object.state, 'retained');
});

test('propagates factory exceptions unchanged and remains usable afterwards', () => {
    const failure = new Error('factory failed');
    let fail = true;
    const pool = new FreeList('errors', 1, () => {
        if (fail) throw failure;
        return 'created';
    });

    assert.throws(() => pool.alloc(), error => error === failure);
    assert.deepEqual(pool.list, []);
    fail = false;
    assert.equal(pool.alloc(), 'created');
    assert.equal(pool.free('returned'), true);
    assert.equal(pool.alloc(), 'returned');
});

test('independent pools never share cached values', () => {
    const first = new FreeList('same-name', 1, () => 'first');
    const second = new FreeList('same-name', 1, () => 'second');

    first.free('cached');
    assert.equal(second.alloc(), 'second');
    assert.equal(first.alloc(), 'cached');
});

test('returns factory promises unchanged', () => {
    const promise = Promise.resolve('created');
    const pool = new FreeList('promises', 1, () => promise);

    assert.equal(pool.alloc(), promise);
    assert.equal(pool.free(promise), true);
    assert.equal(pool.alloc(), promise);
});

test('retains explicit factory side effects when the factory throws', () => {
    const failure = new Error('factory failed after freeing a value');
    const pool = new FreeList('side-effects', 1, function () {
        this.free('retained');
        throw failure;
    });

    assert.throws(() => pool.alloc(), error => error === failure);
    assert.equal(pool.alloc(), 'retained');
    assert.equal(pool.list.length, 0);
});

test('matches a bounded FIFO model across repeated fill and drain operations', () => {
    for (const capacity of [0, 1, 7, 64]) {
        const pool = new FreeList('model', capacity, value => value);
        const expected = [];
        let state = 123456789;

        for (let step = 0; step < 10000; step += 1) {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            if (state % 5 < 3) {
                const accepted = expected.length < capacity;
                assert.equal(pool.free(step), accepted);
                if (accepted) expected.push(step);
            } else {
                assert.equal(pool.alloc(-step), expected.length ? expected.shift() : -step);
            }
            assert.equal(pool.list.length, expected.length);
        }

        while (expected.length) assert.equal(pool.alloc(), expected.shift());
        assert.equal(pool.list.length, 0);
    }
});

test('rejects nonnumeric capacities without coercion', () => {
    for (const max of [undefined, null, '2', true, {}, [], new Number(2), 2n]) {
        assert.throws(() => new FreeList('invalid', max), TypeError);
    }
});

test('rejects nonfinite, fractional, negative, and oversized capacities', () => {
    for (const max of [NaN, Infinity, -Infinity, -1, 0.5, 1.5, 0x100000000]) {
        assert.throws(() => new FreeList('invalid', max), RangeError);
    }
});

test('accepts capacity boundaries without preallocating storage', () => {
    for (const max of [-0, 0, 1, 0xFFFFFFFF]) {
        const pool = new FreeList('boundary', max);
        assert.deepEqual(pool.list, []);
        assert.equal(pool.free('value'), max > 0);
        assert.equal(pool.list.length, max > 0 ? 1 : 0);
    }
});

test('rejects supplied nonfunction factories at construction time', () => {
    for (const factory of [false, 0, '', 'factory', {}, []]) {
        assert.throws(() => new FreeList('invalid', 1, factory), TypeError);
    }
});

test('calling without new fails without modifying the supplied receiver', () => {
    const receiver = {};
    assert.throws(() => FreeList.call(receiver, 'invalid', 1), TypeError);
    assert.deepEqual(receiver, {});
    assert.throws(() => FreeList('invalid', 1), TypeError);
});
