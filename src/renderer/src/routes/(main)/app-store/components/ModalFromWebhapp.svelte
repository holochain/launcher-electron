<script lang="ts">
	import { getModalStore } from '@skeletonlabs/skeleton';

	import { goto } from '$app/navigation';
	import { showModalError } from '$helpers';
	import { i18n, trpc } from '$services';

	import { APPS_VIEW } from '../../../../../../types';
	import ModalForm from './ModalForm.svelte';

	const client = trpc();
	const modalStore = getModalStore();

	let files: FileList | null = null;
	let formData = {
		appId: '',
		networkSeed: ''
	};

	const installedApps = client.getInstalledApps.createQuery();
	const installHappMutation = client.installHapp.createMutation();
</script>

<ModalForm
	bind:formData
	bind:files
	onSubmit={() =>
		$installHappMutation.mutate(
			{
				appId: formData.appId,
				networkSeed: formData.networkSeed,
				filePath: files ? files[0].path : ''
			},
			{
				onSuccess: () => {
					$installedApps.refetch();
					goto(`${APPS_VIEW}?presearch=${formData.appId}`);
					modalStore.close();
				},
				onError: (error) => {
					modalStore.close();
					console.error(error);
					showModalError({
						modalStore,
						errorTitle: $i18n.t('appError'),
						errorMessage: $i18n.t(error.message)
					});
				}
			}
		)}
	isPending={$installHappMutation.isPending}
	acceptFileType={true}
/>
