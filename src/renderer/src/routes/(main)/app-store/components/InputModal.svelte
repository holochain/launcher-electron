<script lang="ts">
	import { Input } from '$components';

	export let label = '';
	export let id: string;
	export let value: string;
</script>

<div class="relative">
	<label for={id} class="absolute left-4 top-4 text-xs opacity-60">{label.toUpperCase()}</label>
	<Input
		bind:value
		props={{
			class: `pl-20 input-modal pt-6`,
			id,
			type: 'text'
		}}
	/>
</div>
