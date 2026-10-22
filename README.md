# freelist

A small, dependency-free CommonJS module for bounded FIFO reuse of JavaScript
values. Originally extracted from Node.js's internal FreeList, by Ryan Dahl.

```sh
npm install freelist
```

```js
var FreeList = require('freelist');
var pool = new FreeList('buffers', 32, function (size) {
    return Buffer.alloc(size);
});

var buffer = pool.alloc(1024); // Empty pool: calls the factory.
buffer.fill(0);                // Reset application state before reuse.
pool.free(buffer);             // true: retained for a later allocation.

var reused = pool.alloc(1024); // Returns the same buffer.
console.log(reused === buffer); // true
```

## API

### `new FreeList(name, max, [factory])`

Creates an independent pool. No backing storage is preallocated.
The capacity range follows the [ECMAScript array length limit](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-array-exotic-objects).

| Parameter | Contract |
| --- | --- |
| `name` | Descriptive metadata of any type; it does not identify a shared pool. |
| `max` | Number of values that may be cached: an integer from `0` to `4294967295`, the maximum JavaScript array length. |
| `factory` | Optional function called when the pool is empty. Omitted or `null` means a function that returns `undefined`. |

`max` limits retained values, not the number of live values or factory calls.
With `max = 0`, every allocation calls the factory and every free returns `false`.

Construction throws `TypeError` when called without `new`, when `max` is not a
number, or when a supplied, non-null factory is not a function. Invalid numeric
capacities (including `NaN`, infinities, fractions, and out-of-range values) throw
`RangeError`. Inputs are not coerced.

### `pool.alloc(...args)`

Removes and returns the oldest cached value. Cached values are returned unchanged;
allocation arguments do not select, resize, validate, or reset them. For example,
a cached 1024-byte buffer is returned even if the next call requests 2048 bytes.
Use separate pools when values have incompatible sizes or configurations.

When the pool is empty, invokes `factory.apply(pool, args)` and returns its result.
The factory is a regular function call, not a `new` expression; wrap class
constructors in a factory function. Return values (including promises and
`undefined`) and thrown exceptions pass through unchanged. A factory failure
does not itself add a cached value; any side effects made by the factory remain.

### `pool.free(value)`

Appends a value to the FIFO queue and returns `true` if space remains. If the pool
is full, returns `false` without retaining the supplied value or evicting a cached
value. Every JavaScript value is accepted, including `null` and `undefined`.

This method does not reset, validate, close, or dispose of a value. It does not
track checked-out values, check their origin, or detect double frees. After a
successful free, the caller must stop using that value until it is allocated
again. Freeing an object twice can return the same object to two consumers.
Application code is responsible for clearing sensitive data and releasing
resources when a value is no longer needed, including when `free()` returns
`false`.

### Compatibility fields and exports

Both imports return the same constructor:

```js
var FreeList = require('freelist');
var LegacyFreeList = require('freelist').FreeList;
```

The historical public fields remain available:

| Field | Contents |
| --- | --- |
| `pool.name` | The supplied metadata. |
| `pool.max` | The cache capacity. |
| `pool.constructor` | The factory function, **not** the `FreeList` class. |
| `pool.list` | The actual array of cached values, in allocation order. |

Treat `max`, `constructor`, and `list` as inspection-only fields. Direct mutation
bypasses the constructor's validation and can invalidate the documented capacity
and FIFO guarantees. The array's identity is preserved across allocations and
frees.

Existing FIFO order, callback context, optional factory behavior, and both export
forms are preserved. **Compatibility change:** invalid constructor inputs now
fail immediately rather than being coerced, silently misconfiguring the pool,
or failing later during allocation.

## Cost and lifetime

Let `n` be the number of cached values. Cache hits use `Array.prototype.shift()`
and may require O(n) element movement. Appending has amortized O(1) cost under the
usual dynamic-array model. Cache misses add the factory's execution cost. These
are algorithmic estimates, not JavaScript engine latency guarantees. The pool
holds O(n) references in addition to the memory retained by the values themselves.

The array-based implementation preserves the public `list` interface and FIFO
behavior. Cached objects remain strongly referenced until allocated, removed by
application code, or the pool itself becomes unreachable. This module provides
neither asynchronous coordination nor resource ownership enforcement.

## Development

Run the regression suite with Node.js 20 or newer using the built-in
[Node.js test runner](https://nodejs.org/api/test.html); no dependencies are needed:

```sh
npm test
```

Tests cover both exports, FIFO reuse, bounded capacity, callback context and
arguments, all value types, exception propagation, independent pools, constructor
validation, and 40000 deterministic operations against a bounded FIFO model.

## License

MIT. See [LICENSE](LICENSE) for the full text.
