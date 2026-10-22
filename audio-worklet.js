/**
 *    Name:         audio-worklet.js
 *    Description:  SCSP audio output in an AudioWorklet: it runs on the browser's AUDIO
 *                  THREAD, immune to the main thread's pauses (GC, loads) that, with the
 *                  deprecated ScriptProcessorNode, produced the "stutter": every pause
 *                  of the main thread was a gap in the audio.
 *                  The main thread sends it stereo chunks (Float32) over the port with
 *                  TRANSFER, and this returns them once played so they can be RECYCLED:
 *                  zero garbage per frame in steady state. Short internal FIFO; underrun =
 *                  brief silence, and it recovers on its own.
 *    Version:      0.1.0
 *    Created:      19-07-2026
 *    Modified:     19-07-2026
 *    Author:       Sebastian Toyos
 */

class OutputScsp extends AudioWorkletProcessor
{
	constructor()
	{
		super();
		this.queue = [];    // chunks {n, left, right} waiting to be played
		this.off = 0;      // read offset inside chunk 0
		this.port.onmessage = (e) => { if(e.data && e.data.chunk) this.queue.push(e.data); };
	}

	process(inputs, outputs)
	{
		const left = outputs[0][0];
		const right = outputs[0][1] || outputs[0][0];
		let i = 0;
		while(i < left.length)
		{
			if(this.queue.length === 0)
			{
				// Underrun: silence for whatever is missing. The main thread refills and it recovers.
				for(; i < left.length; i++) { left[i] = 0; right[i] = 0; }
				break;
			}
			const c = this.queue[0];
			const copy = Math.min(c.n - this.off, left.length - i);
			for(let k = 0; k < copy; k++)
			{
				left[i + k] = c.left[this.off + k];
				right[i + k] = c.right[this.off + k];
			}
			i += copy; this.off += copy;
			if(this.off >= c.n)
			{
				this.off = 0;
				const used = this.queue.shift();
				// Return the buffers to the main thread to RECYCLE them (transfer: no copy).
				this.port.postMessage({ giveBack: true, left: used.left, right: used.right },
					[used.left.buffer, used.right.buffer]);
			}
		}
		return true;
	}
}

registerProcessor("scsp-output", OutputScsp);
