<script lang="ts">
	import { Avatar, getModalStore } from '@skeletonlabs/skeleton';

	import { goto } from '$app/navigation';
	import { showModalError } from '$helpers';
	import { i18n, trpc } from '$services';

	import { APPS_VIEW } from '../../../../../../types';
	import ModalForm from './ModalForm.svelte'; // Updated import

	const client = trpc();

	const modalStore = getModalStore();

	let formData = {
		appId: '',
		networkSeed: ''
	};

	const installedApps = client.getInstalledApps.createQuery();
	const installKandoMutation = client.installKando.createMutation();
</script>

<ModalForm
	bind:formData
	onSubmit={() =>
		$installKandoMutation.mutate(
			{
				appId: formData.appId,
				networkSeed: formData.networkSeed
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
	isPending={$installKandoMutation.isPending}
>
	<slot name="avatar">
		<Avatar initials={'kn'} rounded="rounded-2xl" background="dark:bg-app-gradient" width="w-20" />
	</slot>
</ModalForm>
